import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORIES, PRIORITIES, ROLES, TICKET_STATUSES, TICKET_TRANSITIONS } from "@relay/shared/browser";
import { safeGithubUrl } from "./github";
import { safeNext } from "./redirect";
import type { Ticket } from "./schemas";
import { formatDuration, slaLabel, slaState } from "./sla";
import { LANES, groupByLane, laneOf, legalNextStatuses, matchesQuery, shortId } from "./tickets";
import { relativeTime } from "./time";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();
const ticket = (o: Partial<Ticket> = {}): Ticket => ({
  id: "0a1b2c3d-0000-4000-8000-000000000001", title: "Checkout fails", summary: "s", category: "bug", priority: "P2",
  priorityReason: null, prioritySource: "rules", status: "triaged", assigneeId: null, roleNeeded: null, trackerRef: null,
  switchRoomRef: null, affectedClientCount: 1, slaAckDue: null, slaResolveDue: iso(240), sourceMessageId: null,
  createdAt: iso(-60), resolvedAt: null, ...o,
});

test("lanes: every status is in exactly one lane, in the documented grouping", () => {
  const all = LANES.flatMap((l) => l.statuses);
  assert.equal(all.length, TICKET_STATUSES.length);
  assert.deepEqual([...new Set(all)].sort(), [...TICKET_STATUSES].sort());
  assert.equal(laneOf("quarantined"), "inbox");
  assert.equal(laneOf("escalated"), "triaged");
  assert.equal(laneOf("reopened"), "progress");
  assert.equal(laneOf("closed"), "resolved");
});

test("groupByLane buckets tickets and keeps order", () => {
  const g = groupByLane([ticket({ id: "a", status: "received" }), ticket({ id: "b", status: "resolved" }), ticket({ id: "c", status: "quarantined" })]);
  assert.deepEqual(g.inbox.map((t) => t.id), ["a", "c"]);
  assert.deepEqual(g.resolved.map((t) => t.id), ["b"]);
  assert.equal(g.progress.length, 0);
});

test("legalNextStatuses is exactly the shared transition table", () => {
  for (const s of TICKET_STATUSES) assert.deepEqual(legalNextStatuses(s), TICKET_TRANSITIONS[s]);
  assert.ok(!legalNextStatuses("closed").includes("resolved"));
  assert.deepEqual([...legalNextStatuses("closed")], ["reopened"]);
});

test("shortId and search", () => {
  assert.equal(shortId("0a1b2c3d-0000-4000-8000-000000000001"), "REL-0A1B2C3D");
  assert.ok(matchesQuery(ticket(), "  CHECKOUT "));
  assert.ok(matchesQuery(ticket(), "rel-0a1b"));
  assert.ok(!matchesQuery(ticket(), "refund"));
  assert.ok(matchesQuery(ticket(), ""));
});

test("sla state boundaries", () => {
  // created 10h ago: window = due + 600m, warn = max(30m, window/4) -> due_soon when remaining <= 200m
  const long = (m: number) => ticket({ createdAt: iso(-600), slaResolveDue: iso(m) });
  assert.equal(slaState(long(201), NOW), "ok");
  assert.equal(slaState(long(200), NOW), "due_soon");
  assert.equal(slaState(long(1), NOW), "due_soon");
  assert.equal(slaState(ticket({ slaResolveDue: iso(0) }), NOW), "breached", "exactly at due is breached");
  assert.equal(slaState(ticket({ slaResolveDue: iso(-1) }), NOW), "breached");
  assert.equal(slaState(ticket({ slaResolveDue: null }), NOW), "none");
  // short window: the 30 minute floor applies (window/4 would be ~10m)
  assert.equal(slaState(ticket({ createdAt: iso(-10), slaResolveDue: iso(29) }), NOW), "due_soon");
  assert.equal(slaState(ticket({ createdAt: iso(-10), slaResolveDue: iso(31) }), NOW), "ok");
});

test("finished tickets report met or missed, never breached", () => {
  assert.equal(slaState(ticket({ status: "resolved", resolvedAt: iso(-5), slaResolveDue: iso(-1) }), NOW), "met");
  assert.equal(slaState(ticket({ status: "closed", resolvedAt: iso(-1), slaResolveDue: iso(-5) }), NOW), "missed");
});

test("duration and sla label formatting", () => {
  assert.equal(formatDuration(0), "<1s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(3 * 60_000 + 5_000), "3m 05s");
  assert.equal(formatDuration(42 * 60_000), "42m");
  assert.equal(formatDuration(3 * 3600_000 + 5 * 60_000), "3h 05m");
  assert.equal(formatDuration(52 * 3600_000), "2d 4h");
  assert.equal(formatDuration(-5), "<1s");
  assert.equal(slaLabel(ticket({ slaResolveDue: iso(42) }), NOW), "42m left");
  assert.equal(slaLabel(ticket({ slaResolveDue: iso(-90) }), NOW), "Overdue 1h 30m");
  assert.equal(slaLabel(ticket({ slaResolveDue: null }), NOW), "No SLA");
});

test("relative time", () => {
  const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
  assert.equal(relativeTime(ago(3), NOW), "just now");
  assert.equal(relativeTime(ago(-30), NOW), "just now", "future clamps");
  assert.equal(relativeTime(ago(42), NOW), "42s ago");
  assert.equal(relativeTime(ago(300), NOW), "5m ago");
  assert.equal(relativeTime(ago(3 * 3600), NOW), "3h ago");
  assert.equal(relativeTime(ago(2 * 86400), NOW), "2d ago");
  assert.match(relativeTime(ago(30 * 86400), NOW), /2026/);
  assert.equal(relativeTime("nonsense", NOW), "");
});

test("github url allow-check", () => {
  assert.equal(safeGithubUrl("https://github.com/acme/app/issues/12"), "https://github.com/acme/app/issues/12");
  for (const bad of [
    "http://github.com/a/b/issues/1", "https://evil.com/github.com", "https://github.com.evil.com/x", "javascript:alert(1)",
    "https://user:pw@github.com/a", "https://github.com:8443/a", "//github.com/a", "acme/app#12", "", null, undefined, "data:text/html,x",
  ]) assert.equal(safeGithubUrl(bad as string), null, String(bad));
});

test("post-login redirect only accepts local paths", () => {
  assert.equal(safeNext("/?ticket=abc"), "/?ticket=abc");
  for (const bad of [null, undefined, "", "https://evil.com", "//evil.com", "/\\evil.com", "javascript:x", "/login", "/login?next=/"]) assert.equal(safeNext(bad), "/", String(bad));
});

test("enums used by the UI come from @relay/shared/browser", () => {
  assert.equal(PRIORITIES.length, 4);
  assert.ok(CATEGORIES.includes("bug"));
  assert.ok(ROLES.includes("pm"));
});
