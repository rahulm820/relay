// Priority scoring, routing rules and assignee selection (Issue #10, architecture §8). Pure functions:
// no I/O. The stage (stage.ts) loads the tenant's rules, members and on-call rows and calls these.
import { CATEGORIES, PRIORITIES, ROLES, type Category, type ClientTier, type Priority, type Role } from "@relay/shared";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// 8.1 Priority
// ---------------------------------------------------------------------------------------------

/** Signals that set a hard floor (§8.1 P1 triggers and the blocking P2 trigger). */
const SIGNAL_FLOOR: Record<string, Priority> = {
  outage: "P1",
  data_loss: "P1",
  security: "P1",
  payment_failure: "P1",
  blocking: "P2",
};

const CATEGORY_POINTS: Record<Category, number> = { bug: 3, billing: 3, ui: 2, other: 1, feature: 0, question: 0 };
const TIER_POINTS: Record<ClientTier, number> = { enterprise: 2, paid: 1, free: 0 };
const SENTIMENT_POINTS: Record<string, number> = { angry: 2, frustrated: 1, neutral: 0, positive: 0 };
/** Clients affected by the same issue; dedupe (#11) supplies the count. Until then the stage passes 1. */
const AFFECTED_CLIENTS = { some: 2, many: 5 } as const;
/** Score thresholds, most urgent first. Checked in order. */
const THRESHOLDS: [number, Priority][] = [[10, "P1"], [7, "P2"], [3, "P3"]];

export interface PriorityInput {
  category: Category;
  signals: readonly string[];
  tier: ClientTier | null;
  affectedClientCount: number;
  sentiment: string;
  /** Optional LLM suggestion from the extraction. The rules decide the floor; the suggestion may move the result by one level. */
  llmSuggestion?: { priority: Priority; reason: string };
}

export interface PriorityOutcome {
  priority: Priority;
  reason: string;
  source: "rules" | "llm";
}

const level = (p: Priority): number => PRIORITIES.indexOf(p);
/** The more urgent of two priorities (P1 is most urgent). */
export const mostUrgent = (a: Priority, b: Priority): Priority => (level(a) <= level(b) ? a : b);
const clampLevel = (p: Priority, lo: number, hi: number): Priority => PRIORITIES[Math.min(hi, Math.max(lo, level(p)))]!;

/** Points from the rules, before any floor. Pure and bounded. */
export function scorePoints(input: Omit<PriorityInput, "llmSuggestion">): { points: number; parts: string[] } {
  const parts: string[] = [`${input.category} base ${CATEGORY_POINTS[input.category]}`];
  let points = CATEGORY_POINTS[input.category];
  const signalSet = new Set(input.signals);
  if ([...signalSet].some((s) => SIGNAL_FLOOR[s] === "P1")) {
    points += 6;
    parts.push("severe signal +6");
  } else if (signalSet.has("blocking")) {
    points += 4;
    parts.push("blocking +4");
  }
  if (input.tier) {
    points += TIER_POINTS[input.tier];
    if (TIER_POINTS[input.tier]) parts.push(`${input.tier} client +${TIER_POINTS[input.tier]}`);
  }
  if (input.affectedClientCount >= AFFECTED_CLIENTS.many) {
    points += 3;
    parts.push(`${input.affectedClientCount} clients +3`);
  } else if (input.affectedClientCount >= AFFECTED_CLIENTS.some) {
    points += 1;
    parts.push(`${input.affectedClientCount} clients +1`);
  }
  const sentiment = SENTIMENT_POINTS[input.sentiment] ?? 0;
  if (sentiment) {
    points += sentiment;
    parts.push(`${input.sentiment} sentiment +${sentiment}`);
  }
  return { points, parts };
}

export function levelFromPoints(points: number): Priority {
  for (const [min, p] of THRESHOLDS) if (points >= min) return p;
  return "P4";
}

/**
 * Deterministic floor first, then the optional LLM nudge.
 *   rules  = points level, raised to the strongest signal floor (a rule can only raise)
 *   llm    = suggestion clamped to rules +/- 1, then never less urgent than the signal floor
 * With no LLM suggestion the result is the rules outcome.
 */
export function scorePriority(input: PriorityInput): PriorityOutcome {
  const { points, parts } = scorePoints(input);
  const pointsLevel = levelFromPoints(points);
  const floors = input.signals.map((s) => SIGNAL_FLOOR[s]).filter((p): p is Priority => p !== undefined);
  // §8.1 lists "at least N clients reporting the same issue" as a P1 trigger.
  if (input.affectedClientCount >= AFFECTED_CLIENTS.many) floors.push("P1");
  const floor = floors.length > 0 ? floors.reduce(mostUrgent) : null;
  const rules = floor ? mostUrgent(pointsLevel, floor) : pointsLevel;
  const floorNote = floor ? `; floor ${floor}` : "";
  const rulesReason = `rules: ${parts.join(", ")} = ${points} points -> ${pointsLevel}${floorNote}`;

  if (!input.llmSuggestion) return { priority: rules, reason: rulesReason, source: "rules" };

  const nudged = clampLevel(input.llmSuggestion.priority, level(rules) - 1, level(rules) + 1);
  const final = floor ? mostUrgent(floor, nudged) : nudged;
  if (final === rules) return { priority: rules, reason: `${rulesReason}; llm suggested ${input.llmSuggestion.priority} (no change)`, source: "rules" };
  return { priority: final, reason: `${rulesReason}; llm ${final}: ${input.llmSuggestion.reason}`.slice(0, 500), source: "llm" };
}

// ---------------------------------------------------------------------------------------------
// 8.2 Routing
// ---------------------------------------------------------------------------------------------

/**
 * Condition keys. Anything else makes the rule invalid, and invalid rules are skipped.
 *   priority_gte: matches the given priority or a less urgent one (P3 matches P3 and P4).
 */
export const RuleConditionSchema = z.strictObject({
  category: z.union([z.enum(CATEGORIES), z.array(z.enum(CATEGORIES)).min(1)]).optional(),
  signal: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  tier: z.union([z.enum(["free", "paid", "enterprise"]), z.array(z.enum(["free", "paid", "enterprise"])).min(1)]).optional(),
  priority_gte: z.enum(PRIORITIES).optional(),
});
export type RuleCondition = z.infer<typeof RuleConditionSchema>;

export const RuleActionSchema = z.strictObject({
  role: z.enum(ROLES).optional(),
  channel: z.string().max(100).optional(),
  tracker_labels: z.array(z.string().max(50)).optional(),
  also_notify: z.array(z.enum(ROLES)).optional(),
});
export type RuleAction = z.infer<typeof RuleActionSchema>;

export interface RoutingRule {
  id: string;
  position: number;
  enabled: boolean;
  condition: unknown;
  action: unknown;
}

export interface RoutingResult {
  role: Role;
  alsoNotify: Role[];
  labels: string[];
  channel: string | null;
  /** Which rule matched, or "default". Stored in the decision reason. */
  matched: string;
}

const one = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

export function ruleMatches(cond: RuleCondition, input: { category: Category; signals: readonly string[]; tier: ClientTier | null; priority: Priority }): boolean {
  if (cond.category !== undefined && !one(cond.category).includes(input.category)) return false;
  if (cond.signal !== undefined && !one(cond.signal).some((s) => input.signals.includes(s))) return false;
  if (cond.tier !== undefined && (input.tier === null || !one(cond.tier).includes(input.tier))) return false;
  if (cond.priority_gte !== undefined && level(input.priority) < level(cond.priority_gte)) return false;
  return true;
}

/** Default role mapping from §8.2. Used when no rule matches. */
export function defaultRoute(category: Category, signals: readonly string[]): RoutingResult {
  const security = signals.includes("security");
  const base: Record<Category, { role: Role; also: Role[] }> = {
    bug: { role: "developer", also: ["tester"] },
    ui: { role: "designer", also: [] },
    feature: { role: "pm", also: [] },
    question: { role: "pm", also: [] },
    billing: { role: "pm", also: [] },
    other: { role: "pm", also: [] },
  };
  const b = base[category];
  return {
    role: security ? "developer" : b.role,
    alsoNotify: security ? ["pm"] : b.also,
    labels: [],
    channel: null,
    matched: "default",
  };
}

/**
 * Top-down, first match wins (§8.2). Rules that are disabled or fail validation are skipped, so a bad rule
 * never blocks the pipeline. A matching rule without a role falls back to the default mapping for its fields.
 */
export function routeIssue(
  input: { category: Category; signals: readonly string[]; tier: ClientTier | null; priority: Priority },
  rules: readonly RoutingRule[],
): RoutingResult {
  const sorted = [...rules].filter((r) => r.enabled).sort((a, b) => a.position - b.position);
  for (const rule of sorted) {
    const cond = RuleConditionSchema.safeParse(rule.condition);
    const action = RuleActionSchema.safeParse(rule.action);
    if (!cond.success || !action.success) continue;
    if (!ruleMatches(cond.data, input)) continue;
    const fallback = defaultRoute(input.category, input.signals);
    return {
      role: action.data.role ?? fallback.role,
      alsoNotify: action.data.also_notify ?? fallback.alsoNotify,
      labels: action.data.tracker_labels ?? [],
      channel: action.data.channel ?? null,
      matched: `rule ${rule.position}`,
    };
  }
  return defaultRoute(input.category, input.signals);
}

// ---------------------------------------------------------------------------------------------
// Assignee selection: on-call -> least loaded -> role broadcast (null), respecting working hours
// ---------------------------------------------------------------------------------------------

export interface Member {
  id: string;
  role: Role;
  timezone: string;
  active: boolean;
}

export interface OnCallEntry {
  memberId: string;
  role: Role;
}

export type AssignmentVia = "on_call" | "least_loaded" | "role_broadcast";

export interface Assignment {
  assigneeId: string | null;
  via: AssignmentVia;
}

/** True when the local time in `timezone` is between 08:00 and 19:59. An unknown timezone is treated as outside hours. */
export function isWorkingHours(timezone: string, at: Date): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: timezone }).format(at));
    return hour >= 8 && hour < 20;
  } catch {
    return false;
  }
}

export function selectAssignee(input: {
  role: Role;
  members: readonly Member[];
  onCall: readonly OnCallEntry[];
  /** Open ticket count per member id. Missing ids count as 0. */
  loads: ReadonlyMap<string, number>;
  at: Date;
}): Assignment {
  const candidates = input.members.filter((m) => m.active && m.role === input.role);
  if (candidates.length === 0) return { assigneeId: null, via: "role_broadcast" };

  const onCall = input.onCall.find((o) => o.role === input.role && candidates.some((c) => c.id === o.memberId));
  if (onCall) return { assigneeId: onCall.memberId, via: "on_call" };

  // Working hours first, then the lowest load, then id so the result is deterministic.
  const ranked = [...candidates].sort((a, b) => {
    const hoursA = isWorkingHours(a.timezone, input.at) ? 0 : 1;
    const hoursB = isWorkingHours(b.timezone, input.at) ? 0 : 1;
    if (hoursA !== hoursB) return hoursA - hoursB;
    const loadA = input.loads.get(a.id) ?? 0;
    const loadB = input.loads.get(b.id) ?? 0;
    if (loadA !== loadB) return loadA - loadB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { assigneeId: ranked[0]!.id, via: "least_loaded" };
}
