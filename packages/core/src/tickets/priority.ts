import { PRIORITIES, PRIORITY_SOURCES, ROLES, type Category, type Priority } from "@relay/shared";
import { z } from "zod";

const P1_SIGNALS = new Set(["outage", "data_loss", "security", "payment_failure"]);
const P2_SIGNALS = new Set(["blocking"]);

/**
 * PROVISIONAL priority, used until Issue #10 supplies the real routing decision (see PriorityStageResult).
 * Pure: severity signals first, then category. Mirrors architecture §8.1 loosely and ignores client tier,
 * affected count and sentiment, which #10 owns.
 */
export function provisionalPriority(category: Category, signals: readonly string[]): Priority {
  if (signals.some((s) => P1_SIGNALS.has(s))) return "P1";
  if (signals.some((s) => P2_SIGNALS.has(s))) return "P2";
  if (category === "question" || category === "feature" || category === "other") return "P4";
  return "P3";
}

const LEVEL = Object.fromEntries(PRIORITIES.map((p, i) => [p, i])) as Record<Priority, number>;

/** `min` as a floor on urgency: P4 raised to P3, P1 left alone. */
export function atLeast(priority: Priority, min: Priority): Priority {
  return LEVEL[priority] <= LEVEL[min] ? priority : min;
}

/**
 * What the `priority` stage (Issue #10) stores in its stage result so the ticket stage can use it:
 * `{ decisions: [...] }`, one entry per extracted issue, in order. The skeleton stage stores
 * `{ noop: true }`, which does not match, so the provisional rule applies.
 */
export const PriorityDecisionSchema = z.object({
  priority: z.enum(PRIORITIES),
  reason: z.string().max(500),
  source: z.enum(PRIORITY_SOURCES),
  roleNeeded: z.enum(ROLES).nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  /** Tracker labels from the matching routing rule (used by GitHub sync). */
  labels: z.array(z.string()).optional(),
  /** Roles to notify besides the owner (§8.2 also_notify). */
  alsoNotify: z.array(z.enum(ROLES)).optional(),
});
export type PriorityDecision = z.infer<typeof PriorityDecisionSchema>;
export const PriorityStageResultSchema = z.object({ decisions: z.array(PriorityDecisionSchema) });
export type PriorityStageResult = z.infer<typeof PriorityStageResultSchema>;

