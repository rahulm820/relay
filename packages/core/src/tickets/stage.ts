import { ExtractionOutcomeSchema, isFallback, type ExtractedIssue } from "@relay/shared";
import { PermanentFailureError } from "../queue/index.js";
import type { StageHandler } from "../orchestrator/index.js";
import { atLeast, PriorityStageResultSchema, provisionalPriority } from "./priority.js";
import { attachClientReply, createTicketsForMessage, type NewTicket } from "./service.js";

export interface TicketStageOptions {
  /** Tickets whose extraction confidence is below this are held in quarantine for a human. */
  lowConfidenceThreshold?: number;
}

const ACTOR = { type: "system", ref: "pipeline:ticket" } as const;

/**
 * The `ticket` pipeline stage. Turns the extract stage's outcome into tickets (see TicketStageOptions):
 *   valid complaint     -> one ticket per issue, status `received`, outbox rows written
 *   fallback / no issues -> one generic "needs human triage" ticket, quarantined, P3, outbox rows written
 *   low confidence      -> quarantined (priority at least P3), outbox rows written
 *   sensitive data      -> quarantined, NO outbox rows until a human releases it (quarantined -> triaged)
 *   off-topic / not a complaint -> no ticket; the stage result says so and lists no ticket ids
 *   reply to a pending question (status needs_info) -> attached to that ticket, no new ticket
 * Idempotent: replays find the existing tickets (see createTicketsForMessage).
 */
export function ticketStage(opts: TicketStageOptions = {}): StageHandler {
  const threshold = opts.lowConfidenceThreshold ?? 0.5;

  return async (ctx) => {
    // An answer to a question we asked belongs to the waiting ticket, whatever the extractor made of it.
    const repliedTo = await ctx.db((c) => attachClientReply(c, ctx.messageId, ACTOR));
    if (repliedTo) return { result: { outcome: "reply_appended", ticketIds: [repliedTo] } };

    const extraction = ExtractionOutcomeSchema.safeParse(ctx.results["extract"]);
    if (!extraction.success) throw new PermanentFailureError("no valid extraction result for this message", "no_extraction");
    const outcome = extraction.data;

    // #10 replaces the provisional rule by storing { decisions: [...] } in its stage result.
    const decided = PriorityStageResultSchema.safeParse(ctx.results["priority"]);
    const decisions = decided.success ? decided.data.decisions : [];

    const generic = (reason: string): NewTicket => ({
      issueIndex: 0, title: "Needs human triage", summary: "Automatic extraction did not produce a reliable result. See the original message.",
      category: "other", priority: "P3", priorityReason: `provisional: ${reason}`, prioritySource: "rules",
      quarantineReason: reason, outbox: true,
    });

    let tickets: NewTicket[];
    let outcomeName: string;
    if (isFallback(outcome)) {
      tickets = [generic(`extraction_fallback:${outcome.reason}`)];
      outcomeName = "fallback";
    } else if (!outcome.is_complaint) {
      return { result: { outcome: "not_a_complaint", ticketIds: [] } };
    } else if (outcome.off_topic) {
      return { result: { outcome: "off_topic", ticketIds: [] } };
    } else if (outcome.issues.length === 0) {
      tickets = [generic("no_issues_extracted")];
      outcomeName = "no_issues";
    } else {
      outcomeName = outcome.contains_sensitive_data ? "sensitive" : "tickets";
      tickets = outcome.issues.map((issue: ExtractedIssue, index): NewTicket => {
        const decision = decisions[index];
        const base = decision?.priority ?? provisionalPriority(issue.category, issue.severity_signals);
        const lowConfidence = Math.min(outcome.confidence, issue.confidence) < threshold;
        const sensitive = outcome.contains_sensitive_data;
        const quarantineReason = sensitive ? "sensitive_data" : lowConfidence ? "low_confidence" : undefined;
        return {
          issueIndex: index, title: issue.title, summary: issue.summary, category: issue.category,
          priority: lowConfidence && !sensitive ? atLeast(base, "P3") : base,
          priorityReason: decision?.reason ?? "provisional: severity signals and category",
          prioritySource: decision?.source ?? "rules",
          roleNeeded: decision?.roleNeeded ?? null, assigneeId: decision?.assigneeId ?? null,
          ...(quarantineReason ? { quarantineReason } : {}),
          outbox: !sensitive,
        };
      });
    }

    const created = await ctx.db((c) =>
      createTicketsForMessage(c, { tenantId: ctx.tenantId, messageId: ctx.messageId, traceId: ctx.traceId, actor: ACTOR, tickets }));
    return { result: { outcome: outcomeName, ticketIds: created.map((t) => t.ticketId) } };
  };
}
