import { ExtractionOutcomeSchema, isFallback } from "@relay/shared";
import type { StageHandler } from "../orchestrator/index.js";
import { enqueueClientSend } from "./client-notify.js";
import { transitionTicket } from "./service.js";

const ACTOR = { type: "system", ref: "pipeline:notify" } as const;

/** Stage results of the ticket stage that mean "a ticket exists for this message". */
const TICKET_OUTCOMES = new Set(["tickets", "sensitive", "fallback", "no_issues"]);

/**
 * The `notify` pipeline stage: tells the client what happened to the message they just sent.
 *   tickets created        -> an acknowledgement (sensitive-data tickets add a safety line)
 *   ... with missing_info  -> instead of the ack, the ticket moves received -> needs_info; that status message
 *                             carries 1-2 clarifying items (see transitionTicket -> notifyClientStatusChange)
 *   off-topic              -> a polite scoped refusal
 *   not a complaint        -> nothing (a "thanks" does not need an answer)
 *   reply to a question    -> nothing (the ticket stage attached it to the waiting ticket)
 * It only writes outbox rows; Telegram is contacted later by the client.send handler. Idempotent: the outbox
 * keys are per message, so a redelivered stage queues nothing new.
 */
export function notifyStage(): StageHandler {
  return async (ctx) => {
    const ticket = ctx.results["ticket"] as { outcome?: string; ticketIds?: string[] } | undefined;
    const outcome = ticket?.outcome;
    if (!outcome) return { result: { noop: true, reason: "no ticket stage result" } };

    if (outcome === "off_topic") {
      await ctx.db((c) => enqueueClientSend(c, ctx.tenantId, { kind: "refusal", messageId: ctx.messageId }, ctx.traceId));
      return { result: { sent: ["refusal"] } };
    }
    if (!TICKET_OUTCOMES.has(outcome)) return { result: { sent: [], reason: outcome } };

    const extraction = ExtractionOutcomeSchema.safeParse(ctx.results["extract"]);
    const issues = extraction.success && !isFallback(extraction.data) ? extraction.data.issues : [];

    const clarified = await ctx.db(async (c) => {
      if (outcome !== "tickets") return null;
      const { rows } = await c.query<{ id: string; status: string; source_issue_index: number }>(
        "SELECT id, status, source_issue_index FROM tickets WHERE source_message_id = $1 ORDER BY source_issue_index", [ctx.messageId]);
      const target = rows.find((r) => r.status === "received" && (issues[r.source_issue_index]?.missing_info.length ?? 0) > 0);
      if (!target) return null;
      await transitionTicket(c, { ticketId: target.id, to: "needs_info", actor: ACTOR, reason: "missing information" });
      return target.id;
    });
    if (clarified) return { result: { sent: ["status:needs_info"], ticketId: clarified } };

    await ctx.db((c) => enqueueClientSend(c, ctx.tenantId, { kind: "ack", messageId: ctx.messageId, sensitive: outcome === "sensitive" }, ctx.traceId));
    return { result: { sent: ["ack"] } };
  };
}
