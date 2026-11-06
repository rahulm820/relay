import type { TicketStatus } from "@relay/shared";

// The words Relay says to a client. Fixed English templates, plain text (no parse_mode, so nothing needs
// escaping). The only variable parts are a ticket reference and, for clarifications, up to two short items taken
// from the extractor's `missing_info`, which are model output and therefore cleaned and capped first.

/** `REL-` plus the first 8 hex characters of the ticket id: short enough to quote, unique enough to find. */
export const ticketRef = (ticketId: string): string => `REL-${ticketId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

const MAX_ITEMS = 2;
const MAX_ITEM_CHARS = 60;

/** Turns model-provided labels like "app_version" into short harmless phrases; drops anything else odd. */
export function cleanClarificationItems(items: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
    if (item && !out.includes(item)) out.push(item);
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}

export function ackText(refs: readonly string[], sensitive: boolean): string {
  const base = `Thanks, we've received your report and logged it as ${refs.join(", ")}. A team member will follow up here.`;
  return sensitive ? `${base} For your safety, please don't send passwords, card numbers or one-time codes in this chat.` : base;
}

export function refusalText(): string {
  return "Sorry, this chat is only for reporting problems. If something isn't working, tell us what happened and we'll open a ticket.";
}

export function statusText(status: TicketStatus, ref: string, items: readonly string[]): string {
  switch (status) {
    case "needs_info":
      return items.length > 0
        ? `We've logged your report as ${ref} and need a little more information. Could you tell us: ${items.join(" and ")}?`
        : `We've logged your report as ${ref} and need a little more information. Could you tell us more about what happened?`;
    case "in_progress":
      return `Update on ${ref}: we're now working on it.`;
    case "resolved":
      return `Update on ${ref}: we believe this is resolved. If it still happens, just reply here and we'll look again.`;
    case "reopened":
      return `Update on ${ref}: we've reopened this and are looking into it again.`;
    default:
      throw new Error(`no client template for status ${status}`);
  }
}
