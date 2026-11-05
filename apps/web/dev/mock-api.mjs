// MOCK Relay API for developing and verifying apps/web without Postgres. NOT the real API and never for production.
// It mirrors the contract in apps/api (auth-routes, security, tickets, members): cookie `relay_session`
// (HttpOnly, SameSite=Lax, Path=/api), X-Requested-With: relay-admin on every non-GET, Origin allow-list,
// {error, message?} bodies, 401/403/404/409/429, the transition table, newest-first cursor pagination.
//
//   npm run dev:mock -w @relay/web          (listens on 127.0.0.1:8080; MOCK_PORT to change)
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

if (process.env.NODE_ENV === "production") {
  console.error("mock-api refuses to run with NODE_ENV=production");
  process.exit(1);
}

// MOCK-ONLY credential. The real API has no default password; this exists so the UI can be exercised offline.
export const MOCK_PASSWORD = "relay-mock-pass";
export const COOKIE = "relay_session";

// Copy of packages/shared TICKET_TRANSITIONS. dev/mock-api.test.ts fails if it ever drifts from @relay/shared.
export const TRANSITIONS = {
  received: ["needs_info", "triaged", "quarantined"],
  needs_info: ["triaged", "quarantined"],
  quarantined: ["received", "triaged"],
  triaged: ["assigned", "escalated"],
  assigned: ["in_progress", "escalated"],
  escalated: ["assigned", "in_progress"],
  in_progress: ["in_review", "resolved", "escalated"],
  in_review: ["in_progress", "resolved"],
  resolved: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["assigned", "in_progress"],
};
const PRIORITIES = ["P1", "P2", "P3", "P4"];
const SLA_MIN = { P1: 240, P2: 1440, P3: 4320, P4: 10080 };
const min = (n) => n * 60_000;

const MEMBERS = [
  { id: "7d1c0000-0000-4000-8000-000000000001", name: "Aarav Mehta", role: "developer", active: true },
  { id: "7d1c0000-0000-4000-8000-000000000002", name: "Priya Nair", role: "designer", active: true },
  { id: "7d1c0000-0000-4000-8000-000000000003", name: "Rohan Das", role: "tester", active: true },
  { id: "7d1c0000-0000-4000-8000-000000000004", name: "Meera Iyer", role: "pm", active: true },
];

const events = new Map(); // ticketId -> event[]
const tickets = []; // newest first
let seq = 0;

function addEvent(id, type, actorType, actorRef, payload, at = Date.now()) {
  const list = events.get(id) ?? [];
  list.push({ id: randomUUID(), type, actorType, actorRef, payload, createdAt: new Date(at).toISOString() });
  events.set(id, list);
}

function makeTicket(o) {
  const createdAt = Date.now() - min(o.ageMin ?? 0);
  const id = o.id ?? `${(0xa1b2c3d4 + seq * 7919).toString(16)}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const t = {
    id, title: o.title, summary: o.summary, category: o.category, priority: o.priority,
    priorityReason: o.reason ?? null, prioritySource: o.source ?? "rules", status: "received",
    assigneeId: o.assigneeId ?? null, roleNeeded: o.roleNeeded ?? null, trackerRef: o.trackerRef ?? null,
    switchRoomRef: o.switchRoomRef ?? null, affectedClientCount: o.clients ?? 1,
    slaAckDue: new Date(createdAt + min(Math.min(60, SLA_MIN[o.priority] / 4))).toISOString(),
    slaResolveDue: new Date(createdAt + min(o.slaMin ?? SLA_MIN[o.priority])).toISOString(),
    sourceMessageId: randomUUID(), createdAt: new Date(createdAt).toISOString(), resolvedAt: null,
  };
  tickets.push(t);
  tickets.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  addEvent(id, "created", "system", "pipeline:ticket", { messageId: t.sourceMessageId, category: t.category, priority: t.priority, prioritySource: t.prioritySource }, createdAt);
  let at = createdAt;
  for (const [to, reason, actor] of o.path ?? []) {
    addEvent(id, "status_changed", actor ?? "system", actor === "human" ? `user:${MEMBERS[3].id}` : "pipeline:ticket", { from: t.status, to, ...(reason ? { reason } : {}) }, (at += 20_000));
    t.status = to;
    if (to === "resolved") t.resolvedAt = new Date(at).toISOString();
  }
  if (o.notified) addEvent(id, "client_notified", "system", "pipeline:notify", { kind: "ack" }, at + 5_000);
  return t;
}

function seed() {
  makeTicket({ title: "Checkout button does nothing on Safari", summary: "Customer reports tapping Pay now has no effect on iPhone Safari 17. Reproduced twice with the cart containing a discount code.", category: "bug", priority: "P1", reason: "Blocks payment for paying customers; matches rule 'payments'.", clients: 3, ageMin: 300, slaMin: 240, path: [["triaged"], ["assigned"], ["in_progress"]], assigneeId: MEMBERS[0].id, roleNeeded: "developer", trackerRef: "https://github.com/acme/storefront/issues/412", switchRoomRef: "room-storefront-412", notified: true });
  makeTicket({ title: "Please refund duplicate charge", summary: "Two charges of $49 on the same day for one subscription.", category: "billing", priority: "P2", reason: "Money involved; paid tier.", ageMin: 95, path: [["triaged"], ["assigned"]], assigneeId: MEMBERS[3].id, roleNeeded: "pm", trackerRef: "acme/storefront#418", notified: true });
  makeTicket({ title: "Message could not be understood", summary: "The extractor could not produce a confident classification for this message. A person should read the original and decide.", category: "other", priority: "P3", reason: "Extraction failed validation; held for a human.", source: "rules", ageMin: 22, path: [["quarantined", "Needs human triage: extraction failed validation"]] });
  makeTicket({ title: "Dark mode text unreadable on invoices", summary: "Light grey text on a dark background in the invoice PDF preview.", category: "ui", priority: "P3", reason: "Cosmetic, workaround exists.", ageMin: 180, path: [["triaged"], ["assigned"]], assigneeId: MEMBERS[1].id, roleNeeded: "designer", trackerRef: "https://github.com/acme/storefront/issues/415" });
  makeTicket({ title: "How do I export my data?", summary: "Customer wants a CSV export of past orders and could not find the option.", category: "question", priority: "P4", reason: "Question; docs cover it.", ageMin: 400, path: [["needs_info", "Asked the client which date range they need"]] });
  makeTicket({ title: "Add SSO for our team", summary: "Enterprise customer asks whether SAML SSO is on the roadmap.", category: "feature", priority: "P4", reason: "Feature request.", ageMin: 700 });
  makeTicket({ title: "Login emails arrive 10 minutes late", summary: "Magic-link emails are delayed; users give up and retry.", category: "bug", priority: "P2", reason: "Intermittent, affects several clients.", clients: 5, ageMin: 1700, slaMin: 1440, path: [["triaged"], ["assigned"], ["in_progress"], ["in_review"]], assigneeId: MEMBERS[0].id, roleNeeded: "developer", trackerRef: "https://github.com/acme/storefront/issues/399", switchRoomRef: "room-storefront-399" });
  makeTicket({ title: "Typo on the pricing page", summary: "'Enterprize' is misspelled in the third plan card.", category: "ui", priority: "P4", reason: "Cosmetic.", ageMin: 3000, path: [["triaged"], ["assigned"], ["in_progress"], ["resolved"], ["closed"]], assigneeId: MEMBERS[1].id, trackerRef: "https://github.com/acme/storefront/issues/380", notified: true });
  makeTicket({ title: "App crashes when uploading a 20 MB photo", summary: "Crash on upload from Android; logs unavailable.", category: "bug", priority: "P1", reason: "Crash; reproducible.", source: "llm", clients: 2, ageMin: 410, slaMin: 240, path: [["triaged"], ["escalated", "No developer picked it up within the SLA window"]], roleNeeded: "developer", trackerRef: "javascript:alert(1)" });
  makeTicket({ title: "Profile photo not saving", summary: "Fixed in the last release; client confirmed.", category: "bug", priority: "P3", reason: "Single user.", ageMin: 2000, path: [["triaged"], ["assigned"], ["in_progress"], ["resolved"]], assigneeId: MEMBERS[2].id, notified: true });
}

const FRESH = [
  ["Cannot reset my password", "Reset link says it has expired immediately.", "bug", "P2"],
  ["Invoice shows the wrong company name", "Invoice header uses the old company name.", "billing", "P3"],
  ["Search returns no results for exact titles", "Searching for a full product name finds nothing.", "bug", "P2"],
  ["Can the dashboard be exported as PDF?", "Asking about a printable dashboard view.", "question", "P4"],
  ["Mobile menu overlaps the logo", "On small phones the menu icon covers the logo.", "ui", "P3"],
  ["Site down for users in the EU", "Several clients in Germany report timeouts since this morning.", "bug", "P1"],
];
let freshN = 0;
function spawn() {
  const [title, summary, category, priority] = FRESH[freshN++ % FRESH.length];
  makeTicket({ title, summary, category, priority, reason: "Rule-based priority.", path: [["triaged"]] });
}

// ---- HTTP ----
const sessions = new Map(); // token -> { userId, at }
const failures = new Map(); // email -> count
const user = (email) => ({ id: "5e550000-0000-4000-8000-0000000000aa", email: email.toLowerCase(), name: "Demo Operator", role: "pm" });
const ORIGINS = new Set((process.env.ADMIN_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()));

function readCookie(req) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [n, ...r] = part.trim().split("=");
    if (n === COOKIE) return r.join("=");
  }
  return null;
}
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : undefined); } catch { resolve(null); } }); });

export function createMockServer({ spawnEvery = 0 } = {}) {
  let timer;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (!path.startsWith("/api/")) return send(res, 404, { error: "not_found" });
    const origin = req.headers.origin;
    const originOk = typeof origin === "string" && ORIGINS.has(origin);
    const cors = originOk ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {};
    if (req.method === "OPTIONS") return originOk ? send(res, 204, undefined, { ...cors, "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE", "access-control-allow-headers": "content-type, x-requested-with" }) : send(res, 403, { error: "forbidden" });
    if (req.method !== "GET" && req.method !== "HEAD" && (req.headers["x-requested-with"] !== "relay-admin" || (typeof origin === "string" && !originOk))) return send(res, 403, { error: "csrf_failed" }, cors);
    const reply = (status, body, h) => send(res, status, body, { ...cors, ...h });

    if (path === "/api/auth/login" && req.method === "POST") {
      const b = await readBody(req);
      if (!b || typeof b.email !== "string" || typeof b.password !== "string") return reply(400, { error: "validation_error", message: "email and password are required" });
      const key = b.email.toLowerCase();
      if ((failures.get(key) ?? 0) >= 5) return reply(429, { error: "too_many_attempts", message: "try again later" }, { "retry-after": "30" });
      if (b.password !== MOCK_PASSWORD) { failures.set(key, (failures.get(key) ?? 0) + 1); return reply(401, { error: "invalid_credentials", message: "invalid email or password" }); }
      failures.delete(key);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { email: b.email, at: Date.now() });
      return reply(200, { user: user(b.email), tenant: { id: "7e5a0000-0000-4000-8000-000000000001", name: "Acme Storefront" } }, { "set-cookie": `${COOKIE}=${token}; Max-Age=43200; Path=/api; HttpOnly; SameSite=Lax` });
    }
    const token = readCookie(req);
    const session = token ? sessions.get(token) : undefined;
    if (path === "/api/auth/logout" && req.method === "POST") {
      if (token) sessions.delete(token);
      return reply(204, undefined, { "set-cookie": `${COOKIE}=; Max-Age=0; Path=/api; HttpOnly; SameSite=Lax` });
    }
    if (!session) return reply(401, { error: "unauthorized" });
    // Test hook so the UI's mid-session 401 path can be exercised: POST /api/__mock/expire ends every session.
    if (path === "/api/__mock/expire" && req.method === "POST") { sessions.clear(); return reply(204); }
    if (path === "/api/auth/me") return reply(200, { user: user(session.email), tenant: { id: "7e5a0000-0000-4000-8000-000000000001", name: "Acme Storefront" } });
    if (path === "/api/members") return reply(200, { items: MEMBERS });

    if (path === "/api/tickets" && req.method === "GET") {
      const q = url.searchParams;
      const limit = Number(q.get("limit") ?? 25);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return reply(400, { error: "validation_error", message: "invalid field(s): limit" });
      let rows = tickets.filter((t) => (!q.get("status") || t.status === q.get("status")) && (!q.get("priority") || t.priority === q.get("priority")) && (!q.get("category") || t.category === q.get("category")) && (!q.get("assigneeId") || t.assigneeId === q.get("assigneeId")));
      const cur = q.get("cursor");
      if (cur) { const [at, id] = Buffer.from(cur, "base64url").toString().split("|"); rows = rows.filter((t) => t.createdAt < at || (t.createdAt === at && t.id < id)); }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return reply(200, { items: page, nextCursor: rows.length > limit && last ? Buffer.from(`${last.createdAt}|${last.id}`).toString("base64url") : null });
    }
    const m = /^\/api\/tickets\/([^/]+)(\/transition)?$/.exec(path);
    if (m) {
      const t = tickets.find((x) => x.id === m[1]);
      if (!t) return reply(404, { error: "not_found" });
      if (!m[2] && req.method === "GET") return reply(200, { ticket: t, events: events.get(t.id) ?? [] });
      if (!m[2] && req.method === "PATCH") {
        const b = await readBody(req);
        const keys = b && typeof b === "object" ? Object.keys(b) : [];
        if (!keys.length || keys.some((k) => !["priority", "assigneeId", "status"].includes(k)) || ("priority" in b && !PRIORITIES.includes(b.priority))) return reply(400, { error: "validation_error", message: "invalid field(s): body" });
        if ("assigneeId" in b && b.assigneeId !== null && !MEMBERS.some((x) => x.id === b.assigneeId)) return reply(400, { error: "assignee_invalid" });
        if ("priority" in b && b.priority !== t.priority) {
          addEvent(t.id, "priority_changed", "human", `user:${session.email}`, { from: t.priority, to: b.priority });
          t.priority = b.priority; t.prioritySource = "human";
          t.slaResolveDue = new Date(Date.parse(t.createdAt) + min(SLA_MIN[b.priority])).toISOString();
        }
        if ("assigneeId" in b && b.assigneeId !== t.assigneeId) { addEvent(t.id, "assignee_changed", "human", `user:${session.email}`, { from: t.assigneeId, to: b.assigneeId }); t.assigneeId = b.assigneeId; }
        return reply(200, { ticket: t });
      }
      if (m[2] && req.method === "POST") {
        const b = await readBody(req);
        const ok = b && typeof b === "object" && Object.keys(b).every((k) => ["to", "from", "reason"].includes(k)) && b.to in TRANSITIONS && (b.from === undefined || b.from in TRANSITIONS) && (b.reason === undefined || (typeof b.reason === "string" && b.reason.length <= 200));
        if (!ok) return reply(400, { error: "validation_error", message: "invalid field(s): body" });
        if (b.from && b.from !== t.status) return reply(409, { error: "status_conflict", message: `ticket is ${t.status}, not ${b.from}` });
        if (!TRANSITIONS[t.status].includes(b.to)) return reply(409, { error: "illegal_transition", message: `cannot move from ${t.status} to ${b.to}` });
        addEvent(t.id, "status_changed", "human", `user:${session.email}`, { from: t.status, to: b.to, ...(b.reason ? { reason: b.reason } : {}) });
        t.status = b.to;
        t.resolvedAt = b.to === "resolved" ? new Date().toISOString() : b.to === "reopened" ? null : t.resolvedAt;
        return reply(200, { ticket: t });
      }
    }
    return reply(404, { error: "not_found" });
  });
  server.on("listening", () => { if (spawnEvery > 0) { timer = setInterval(spawn, spawnEvery); timer.unref(); } });
  server.on("close", () => clearInterval(timer));
  return server;
}

export function resetMock() { tickets.length = 0; events.clear(); sessions.clear(); failures.clear(); seq = 0; freshN = 0; seed(); }
export { tickets };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  resetMock();
  const port = Number(process.env.MOCK_PORT ?? 8080);
  createMockServer({ spawnEvery: 30_000 }).listen(port, "127.0.0.1", () => {
    console.log(`mock Relay API on http://127.0.0.1:${port}  (MOCK ONLY; any email, password "${MOCK_PASSWORD}"; new ticket every 30s)`);
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
