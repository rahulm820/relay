// The `priority` pipeline stage (Issue #10). Stores `{ decisions: [...] }` with one entry per extracted issue,
// in issue order, which the ticket stage reads (see PriorityDecisionSchema in tickets/priority.ts).
//
// The stage writes nothing. The ticket stage stores the decisions with the tickets, so SLA due dates come
// from the matching sla_policies row at insert time. Human overrides are handled by patchTicket (sets
// priority_source = human and writes audit_log).
import { ExtractionOutcomeSchema, isFallback, type ClientTier, type Priority, type Role } from "@relay/shared";
import type { Client } from "@relay/db";
import { PermanentFailureError } from "../queue/index.js";
import type { StageHandler } from "../orchestrator/index.js";
import { routeIssue, scorePriority, selectAssignee, type Member, type OnCallEntry, type RoutingRule } from "./engine.js";

export interface PriorityStageOptions {
  /** Clock for on-call windows and working hours. Injected in tests. */
  now?: () => Date;
}

interface World {
  tier: ClientTier | null;
  rules: RoutingRule[];
  members: Member[];
  onCall: OnCallEntry[];
  loads: Map<string, number>;
}

async function loadWorld(c: Client, messageId: string, at: Date): Promise<World> {
  const tier = (await c.query<{ tier: ClientTier }>(
    `SELECT cl.tier FROM messages m
       JOIN conversations v ON v.id = m.conversation_id
       JOIN clients cl ON cl.id = v.client_id
      WHERE m.id = $1`,
    [messageId],
  )).rows[0]?.tier ?? null;

  const rules = (await c.query<{ id: string; position: number; enabled: boolean; condition_json: unknown; action_json: unknown }>(
    "SELECT id, position, enabled, condition_json, action_json FROM routing_rules ORDER BY position",
  )).rows.map((r) => ({ id: r.id, position: r.position, enabled: r.enabled, condition: r.condition_json, action: r.action_json }));

  const members = (await c.query<{ id: string; role: Role; timezone: string; active: boolean }>(
    "SELECT id, role, timezone, active FROM members WHERE active",
  )).rows;

  const onCall = (await c.query<{ member_id: string; role: Role }>(
    "SELECT member_id, role FROM on_call WHERE starts_at <= $1 AND ends_at > $1",
    [at],
  )).rows.map((r) => ({ memberId: r.member_id, role: r.role }));

  const loads = new Map((await c.query<{ assignee_id: string; n: number }>(
    `SELECT assignee_id, count(*)::int AS n FROM tickets
      WHERE assignee_id IS NOT NULL AND status NOT IN ('resolved', 'closed') GROUP BY assignee_id`,
  )).rows.map((r) => [r.assignee_id, r.n]));

  return { tier, rules, members, onCall, loads };
}

export function priorityStage(opts: PriorityStageOptions = {}): StageHandler {
  const now = opts.now ?? (() => new Date());

  return async (ctx) => {
    const parsed = ExtractionOutcomeSchema.safeParse(ctx.results["extract"]);
    if (!parsed.success) throw new PermanentFailureError("no valid extraction result for this message", "no_extraction");
    const outcome = parsed.data;

    // Nothing to prioritise: the ticket stage handles fallbacks, off-topic and non-complaints without decisions.
    if (isFallback(outcome) || !outcome.is_complaint || outcome.off_topic || outcome.issues.length === 0) {
      return { result: { decisions: [] } };
    }

    const at = now();
    const world = await ctx.db((c) => loadWorld(c, ctx.messageId, at));

    const decisions = outcome.issues.map((issue) => {
      // Affected count stays at 1 until dedupe (#11) supplies it.
      const scored = scorePriority({
        category: issue.category,
        signals: issue.severity_signals,
        tier: world.tier,
        affectedClientCount: 1,
        sentiment: outcome.sentiment,
      });
      const routed = routeIssue({ category: issue.category, signals: issue.severity_signals, tier: world.tier, priority: scored.priority }, world.rules);
      const assignment = selectAssignee({ role: routed.role, members: world.members, onCall: world.onCall, loads: world.loads, at });
      // Later issues in the same message see this assignment, so one person does not take them all.
      if (assignment.assigneeId) world.loads.set(assignment.assigneeId, (world.loads.get(assignment.assigneeId) ?? 0) + 1);
      return {
        priority: scored.priority as Priority,
        reason: `${scored.reason}; route ${routed.matched} -> ${routed.role}${assignment.via === "role_broadcast" ? " (broadcast)" : ""}`.slice(0, 500),
        source: scored.source,
        roleNeeded: routed.role,
        assigneeId: assignment.assigneeId,
        labels: routed.labels,
        alsoNotify: routed.alsoNotify,
      };
    });

    return { result: { decisions } };
  };
}
