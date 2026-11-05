import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvent, quarantineReason } from "./events";
import type { TicketEvent } from "./schemas";

const ev = (type: string, payload: Record<string, unknown>, actorType: TicketEvent["actorType"] = "system"): TicketEvent => ({ id: "e", type, actorType, actorRef: null, payload, createdAt: "2026-11-05T00:00:00Z" });
const names = new Map([["m1", "Priya Nair"]]);

test("status change reads from -> to with reason; unknown values never leak", () => {
  assert.deepEqual(describeEvent(ev("status_changed", { from: "received", to: "quarantined", reason: "bad extraction" }), names), { kind: "status", title: "Received → Needs human triage", detail: "bad extraction", actor: "Relay" });
  assert.equal(describeEvent(ev("status_changed", { from: "<img onerror=x>", to: 5 }), names).title, "? → ?");
});

test("assignee and priority events", () => {
  assert.equal(describeEvent(ev("assignee_changed", { from: null, to: "m1" }, "human"), names).title, "Assignee: nobody → Priya Nair");
  assert.equal(describeEvent(ev("assignee_changed", { from: "zzz", to: "m1" }), names).title, "Assignee: a teammate → Priya Nair");
  assert.equal(describeEvent(ev("priority_changed", { from: "P3", to: "P1" }, "human"), names).actor, "A teammate");
});

test("unknown event types show the name only, never the payload", () => {
  const l = describeEvent(ev("sla_warning_sent", { secret: "do not show" }), names);
  assert.equal(l.title, "Sla warning sent");
  assert.ok(!JSON.stringify(l).includes("do not show"));
});

test("quarantine reason is the latest move into quarantine", () => {
  const events = [ev("status_changed", { from: "received", to: "quarantined", reason: "old" }), ev("status_changed", { from: "quarantined", to: "triaged" }), ev("status_changed", { from: "triaged", to: "quarantined", reason: "new" })];
  assert.equal(quarantineReason(events), "new");
  assert.equal(quarantineReason([]), undefined);
});
