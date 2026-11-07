import { ApiErrorSchema, type TicketStatus, type Priority } from "@relay/shared/browser";
import type { z } from "zod";
import { BotEnvelopeSchema, BotsSchema, ChatConnectionsSchema, IntegrationEnvelopeSchema, IntegrationsSchema, MeSchema, MemberEnvelopeSchema, MembersSchema, OutbacklogSchema, OutboxStatsSchema, RoutingRuleEnvelopeSchema, RoutingRulesSchema, SlaPoliciesSchema, SlaPolicyEnvelopeSchema, SyncResultSchema, TicketDetailSchema, TicketEnvelopeSchema, TicketListSchema, type Me } from "./schemas";

export type ApiErrorKind =
  | "unauthorized" // 401: the session ended (or login failed)
  | "csrf" // 403 csrf_failed
  | "forbidden" // 403 forbidden: wrong role
  | "throttled" // 429
  | "illegal_transition" // 409
  | "status_conflict" // 409
  | "not_found"
  | "validation"
  | "server"
  | "network"
  | "contract"; // the response did not match what we expect

export class ApiRequestError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    message: string,
    /** Seconds, from Retry-After on a 429. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Pure: turns an HTTP failure into one typed error. Messages are fixed text; server `message` is only used for 409s. */
export function mapApiError(status: number, body: unknown, retryAfterHeader?: string | null): ApiRequestError {
  const parsed = ApiErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error : undefined;
  const msg = parsed.success ? parsed.data.message : undefined;
  if (status === 401) return new ApiRequestError("unauthorized", 401, "Your session has ended. Sign in again.");
  if (status === 403) {
    return code === "csrf_failed"
      ? new ApiRequestError("csrf", 403, "The request was rejected as unsafe. Reload the page and try again.")
      : new ApiRequestError("forbidden", 403, "You do not have permission to do that.");
  }
  if (status === 429) {
    const n = Number(retryAfterHeader);
    return new ApiRequestError("throttled", 429, "Too many attempts.", Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined);
  }
  if (status === 409) {
    if (code === "illegal_transition") return new ApiRequestError("illegal_transition", 409, msg ?? "That move is not allowed.");
    return new ApiRequestError("status_conflict", 409, msg ?? "The ticket changed in the meantime.");
  }
  if (status === 404) return new ApiRequestError("not_found", 404, "Not found.");
  if (status === 400) return new ApiRequestError("validation", 400, msg ?? "The request was not valid.");
  return new ApiRequestError("server", status, "The server had a problem. Try again in a moment.");
}

const CSRF = { "X-Requested-With": "relay-admin" } as const;

async function request<S extends z.ZodType>(method: string, path: string, schema: S | null, body?: unknown): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: { ...(method !== "GET" ? CSRF : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiRequestError("network", 0, "Cannot reach the server. Check your connection.");
  }
  if (!res.ok) {
    const json: unknown = await res.json().catch(() => null);
    throw mapApiError(res.status, json, res.headers.get("retry-after"));
  }
  if (!schema) return undefined as z.output<S>;
  const json: unknown = await res.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiRequestError("contract", res.status, "The server sent an unexpected response.");
  return parsed.data;
}

export interface TicketQuery { priority?: Priority | "all"; category?: string; limit?: number }

export const api = {
  login: (email: string, password: string): Promise<Me> => request("POST", "/auth/login", MeSchema, { email, password }),
  logout: async (): Promise<void> => { await request("POST", "/auth/logout", null); },
  me: (): Promise<Me> => request("GET", "/auth/me", MeSchema),
  listTickets: (q: TicketQuery = {}) => {
    const p = new URLSearchParams({ limit: String(q.limit ?? 100) });
    if (q.priority && q.priority !== "all") p.set("priority", q.priority);
    if (q.category && q.category !== "all") p.set("category", q.category);
    return request("GET", `/tickets?${p}`, TicketListSchema);
  },
  getTicket: (id: string) => request("GET", `/tickets/${encodeURIComponent(id)}`, TicketDetailSchema),
  transition: (id: string, to: TicketStatus, from: TicketStatus, reason?: string) =>
    request("POST", `/tickets/${encodeURIComponent(id)}/transition`, TicketEnvelopeSchema, { to, from, ...(reason ? { reason } : {}) }),
  patchTicket: (id: string, patch: { priority?: Priority; assigneeId?: string | null }) =>
    request("PATCH", `/tickets/${encodeURIComponent(id)}`, TicketEnvelopeSchema, patch),
  members: () => request("GET", "/members", MembersSchema),
  // ---- Admin / setup (pm role for writes; reads need a session) ----
  bots: {
    list: () => request("GET", "/bots", BotsSchema),
    create: (b: { channel: string; displayName: string; credentialsRef: string }) => request("POST", "/bots", BotEnvelopeSchema, b),
    patch: (id: string, b: { displayName?: string; credentialsRef?: string }) => request("PATCH", `/bots/${encodeURIComponent(id)}`, BotEnvelopeSchema, b),
    remove: (id: string) => request("DELETE", `/bots/${encodeURIComponent(id)}`, null),
  },
  integrations: {
    list: () => request("GET", "/integrations", IntegrationsSchema),
    create: (b: Record<string, unknown>) => request("POST", "/integrations", IntegrationEnvelopeSchema, b),
    patch: (id: string, b: Record<string, unknown>) => request("PATCH", `/integrations/${encodeURIComponent(id)}`, IntegrationEnvelopeSchema, b),
    resync: (id: string) => request("POST", `/integrations/${encodeURIComponent(id)}/resync`, SyncResultSchema, {}),
  },
  routingRules: {
    list: () => request("GET", "/routing-rules", RoutingRulesSchema),
    create: (b: { position: number; condition: Record<string, unknown>; action: Record<string, unknown>; enabled?: boolean }) => request("POST", "/routing-rules", RoutingRuleEnvelopeSchema, b),
    patch: (id: string, b: Record<string, unknown>) => request("PATCH", `/routing-rules/${encodeURIComponent(id)}`, RoutingRuleEnvelopeSchema, b),
    remove: (id: string) => request("DELETE", `/routing-rules/${encodeURIComponent(id)}`, null),
  },
  slaPolicies: {
    list: () => request("GET", "/sla-policies", SlaPoliciesSchema),
    patch: (id: string, b: { ackMinutes?: number; resolveMinutes?: number }) => request("PATCH", `/sla-policies/${encodeURIComponent(id)}`, SlaPolicyEnvelopeSchema, b),
  },
  chatConnections: {
    list: () => request("GET", "/chat-connections", ChatConnectionsSchema),
  },
  memberAdmin: {
    create: (b: Record<string, unknown>) => request("POST", "/members", MemberEnvelopeSchema, b),
  },
  trackerSync: (ticketId: string) => request("POST", `/tickets/${encodeURIComponent(ticketId)}/tracker-sync`, SyncResultSchema, {}),
  outboxStats: () => request("GET", "/outbox/stats", OutboxStatsSchema),
  outbacklog: () => request("GET", "/outbacklog", OutbacklogSchema),
};
