// Assembles a GitHub issue from a ticket (architecture §4.10.1). Everything here comes from already
// redacted extraction output (Issue #7); nothing is read from the raw message.

export interface IssueSource {
  ticketId: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  priorityReason?: string | null;
  clientTier?: string | null;
  affectedClientCount: number;
  stepsToReproduce?: string[];
  expected?: string | null;
  actual?: string | null;
  missingInfo?: string[];
}

/** Maps category and priority to label names, from integrations.label_map_json. */
export interface LabelMap {
  category?: Record<string, string>;
  priority?: Record<string, string>;
}

export function parseLabelMap(json: unknown): LabelMap {
  if (json === null || typeof json !== "object") return {};
  const o = json as Record<string, unknown>;
  const pick = (v: unknown): Record<string, string> | undefined => {
    if (v === null || typeof v !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
    return out;
  };
  return { category: pick(o["category"]), priority: pick(o["priority"]) };
}

export function labelsFor(issue: Pick<IssueSource, "category" | "priority">, map: LabelMap): string[] {
  const labels = [map.category?.[issue.category], map.priority?.[issue.priority]];
  return [...new Set(labels.filter((l): l is string => typeof l === "string" && l.length > 0))];
}

const list = (items: string[] | undefined): string =>
  items && items.length > 0 ? items.map((s) => `- ${s}`).join("\n") : "";

export function buildIssueBody(src: IssueSource): string {
  const sections: string[] = [];
  sections.push(src.summary.trim() || "_No summary was extracted. See the Relay ticket._");

  const meta = [
    `**Priority:** ${src.priority}${src.priorityReason ? ` (${src.priorityReason})` : ""}`,
    `**Category:** ${src.category}`,
    `**Customer impact:** ${src.clientTier ? `${src.clientTier} tier, ` : ""}${src.affectedClientCount} affected client${src.affectedClientCount === 1 ? "" : "s"}`,
  ];
  sections.push(meta.join("  \n"));

  const steps = list(src.stepsToReproduce);
  if (steps) sections.push(`### Steps to reproduce\n${steps.split("\n").map((l, i) => (l.startsWith("- ") ? `${i + 1}. ${l.slice(2)}` : l)).join("\n")}`);
  if (src.expected) sections.push(`### Expected\n${src.expected}`);
  if (src.actual) sections.push(`### Actual\n${src.actual}`);
  const missing = list(src.missingInfo);
  if (missing) sections.push(`### Missing information\n${missing}`);

  sections.push(`---\n_Created from Relay ticket \`${src.ticketId}\`._`);
  return sections.join("\n\n");
}
