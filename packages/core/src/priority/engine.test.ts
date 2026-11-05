import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultRoute, isWorkingHours, levelFromPoints, routeIssue, scorePriority, selectAssignee, type Member, type RoutingRule,
} from "./engine.js";

const base = { category: "bug" as const, signals: [] as string[], tier: "free" as const, affectedClientCount: 1, sentiment: "neutral" };

describe("scorePriority: acceptance cases", () => {
  it("enterprise + payment failure is P1", () => {
    assert.equal(scorePriority({ ...base, tier: "enterprise", signals: ["payment_failure"] }).priority, "P1");
  });
  it("a question is P4", () => {
    assert.equal(scorePriority({ ...base, category: "question" }).priority, "P4");
  });
  it("a question with an angry customer still does not rise above P4 without a signal", () => {
    assert.equal(scorePriority({ ...base, category: "question", sentiment: "angry", tier: "free" }).priority, "P4");
  });
  it("a rule cannot lower a floor: a P1 signal stays P1 even for a P4 category", () => {
    assert.equal(scorePriority({ ...base, category: "feature", signals: ["security"] }).priority, "P1");
  });
});

describe("scorePriority: scoring table", () => {
  it("minor bug is P3", () => assert.equal(scorePriority(base).priority, "P3"));
  it("blocking bug is P2 via the signal floor", () => assert.equal(scorePriority({ ...base, signals: ["blocking"] }).priority, "P2"));
  it("enterprise blocked bug is P2, not P1", () => {
    assert.equal(scorePriority({ ...base, tier: "enterprise", signals: ["blocking"] }).priority, "P2");
  });
  it("many affected clients (N=5) is a P1 floor", () => {
    assert.equal(scorePriority({ ...base, affectedClientCount: 5 }).priority, "P1");
  });
  it("two affected clients add points but no floor", () => {
    assert.equal(scorePriority({ ...base, affectedClientCount: 2 }).priority, "P3");
  });
  it("levelFromPoints thresholds", () => {
    assert.equal(levelFromPoints(10), "P1");
    assert.equal(levelFromPoints(7), "P2");
    assert.equal(levelFromPoints(3), "P3");
    assert.equal(levelFromPoints(2), "P4");
  });
  it("reason names the rules that applied", () => {
    const r = scorePriority({ ...base, signals: ["payment_failure"], tier: "enterprise" });
    assert.match(r.reason, /severe signal/);
    assert.match(r.reason, /floor P1/);
    assert.equal(r.source, "rules");
  });
});

describe("scorePriority: LLM nudge", () => {
  it("the LLM may raise a level by one, with its reason and source llm", () => {
    const r = scorePriority({ ...base, llmSuggestion: { priority: "P2", reason: "customer cannot log in" } });
    assert.equal(r.priority, "P2");
    assert.equal(r.source, "llm");
    assert.match(r.reason, /customer cannot log in/);
  });
  it("a suggestion more than one level away is clamped to one level", () => {
    assert.equal(scorePriority({ ...base, llmSuggestion: { priority: "P1", reason: "x" } }).priority, "P2");
  });
  it("the LLM cannot lower a rule floor", () => {
    const r = scorePriority({ ...base, signals: ["payment_failure"], llmSuggestion: { priority: "P2", reason: "minor" } });
    assert.equal(r.priority, "P1");
    assert.equal(r.source, "rules");
  });
  it("the LLM can lower by one level when no floor applies", () => {
    const r = scorePriority({ ...base, category: "bug", llmSuggestion: { priority: "P4", reason: "cosmetic" } });
    assert.equal(r.priority, "P4");
    assert.equal(r.source, "llm");
  });
  it("a suggestion equal to the rules result keeps source rules", () => {
    assert.equal(scorePriority({ ...base, llmSuggestion: { priority: "P3", reason: "agree" } }).source, "rules");
  });
});

const rule = (position: number, condition: unknown, action: unknown, enabled = true): RoutingRule => ({
  id: `r${position}`, position, enabled, condition, action,
});

describe("routing", () => {
  it("default mapping follows architecture 8.2", () => {
    assert.equal(defaultRoute("bug", []).role, "developer");
    assert.deepEqual(defaultRoute("bug", []).alsoNotify, ["tester"]);
    assert.equal(defaultRoute("ui", []).role, "designer");
    assert.equal(defaultRoute("feature", []).role, "pm");
    assert.equal(defaultRoute("question", []).role, "pm");
    assert.equal(defaultRoute("billing", []).role, "pm");
  });
  it("security goes to developer and also notifies pm", () => {
    const r = defaultRoute("question", ["security"]);
    assert.equal(r.role, "developer");
    assert.deepEqual(r.alsoNotify, ["pm"]);
  });
  it("first matching rule wins, top-down by position", () => {
    const rules = [
      rule(2, { category: "ui" }, { role: "tester" }),
      rule(1, { category: "ui", priority_gte: "P3" }, { role: "designer", tracker_labels: ["ui"], also_notify: ["pm"] }),
    ];
    const r = routeIssue({ category: "ui", signals: [], tier: null, priority: "P3" }, rules);
    assert.equal(r.role, "designer");
    assert.deepEqual(r.labels, ["ui"]);
    assert.deepEqual(r.alsoNotify, ["pm"]);
    assert.equal(r.matched, "rule 1");
  });
  it("priority_gte matches the level and less urgent ones only", () => {
    const rules = [rule(1, { category: "ui", priority_gte: "P3" }, { role: "designer" })];
    assert.equal(routeIssue({ category: "ui", signals: [], tier: null, priority: "P2" }, rules).matched, "default");
    assert.equal(routeIssue({ category: "ui", signals: [], tier: null, priority: "P4" }, rules).role, "designer");
  });
  it("disabled rules are skipped", () => {
    const rules = [rule(1, { category: "bug" }, { role: "pm" }, false)];
    assert.equal(routeIssue({ category: "bug", signals: [], tier: null, priority: "P3" }, rules).role, "developer");
  });
  it("invalid rules (unknown keys, bad values) are skipped, not fatal", () => {
    const rules = [
      rule(1, { category: "bug", colour: "red" }, { role: "pm" }),
      rule(2, { category: "bug" }, { role: "not-a-role" }),
      rule(3, { category: "bug" }, { role: "tester" }),
    ];
    assert.equal(routeIssue({ category: "bug", signals: [], tier: null, priority: "P3" }, rules).role, "tester");
  });
  it("tier and signal conditions", () => {
    const rules = [rule(1, { tier: "enterprise", signal: "payment_failure" }, { role: "pm" })];
    assert.equal(routeIssue({ category: "bug", signals: ["payment_failure"], tier: "enterprise", priority: "P1" }, rules).role, "pm");
    assert.equal(routeIssue({ category: "bug", signals: ["payment_failure"], tier: "free", priority: "P1" }, rules).role, "developer");
  });
});

const member = (id: string, role: Member["role"], timezone = "UTC", active = true): Member => ({ id, role, timezone, active });
const NOON_UTC = new Date("2026-11-05T12:00:00Z");

describe("assignee selection", () => {
  it("on-call member for the role wins over load", () => {
    const a = selectAssignee({
      role: "developer", members: [member("m1", "developer"), member("m2", "developer")],
      onCall: [{ memberId: "m2", role: "developer" }], loads: new Map([["m2", 9]]), at: NOON_UTC,
    });
    assert.deepEqual(a, { assigneeId: "m2", via: "on_call" });
  });
  it("least loaded when nobody is on call", () => {
    const a = selectAssignee({
      role: "developer", members: [member("m1", "developer"), member("m2", "developer")],
      onCall: [], loads: new Map([["m1", 4], ["m2", 1]]), at: NOON_UTC,
    });
    assert.deepEqual(a, { assigneeId: "m2", via: "least_loaded" });
  });
  it("prefers a member within working hours over a less loaded one outside them", () => {
    // At 12:00 UTC: UTC is 12:00 (inside hours, load 3); Auckland is 01:00 (outside hours, load 0).
    const a = selectAssignee({
      role: "developer",
      members: [member("auckland", "developer", "Pacific/Auckland"), member("utc", "developer", "UTC")],
      onCall: [], loads: new Map([["utc", 3]]), at: NOON_UTC,
    });
    assert.equal(a.assigneeId, "utc");
  });
  it("within working hours, the lighter member wins", () => {
    // At 12:00 UTC: Kolkata is 17:30 (inside hours, load 0); UTC is 12:00 (inside hours, load 3).
    const a = selectAssignee({
      role: "developer",
      members: [member("kolkata", "developer", "Asia/Kolkata"), member("utc", "developer", "UTC")],
      onCall: [], loads: new Map([["utc", 3]]), at: NOON_UTC,
    });
    assert.equal(a.assigneeId, "kolkata");
  });
  it("inactive members and other roles are ignored", () => {
    const a = selectAssignee({
      role: "designer", members: [member("dev", "developer"), member("gone", "designer", "UTC", false)],
      onCall: [], loads: new Map(), at: NOON_UTC,
    });
    assert.deepEqual(a, { assigneeId: null, via: "role_broadcast" });
  });
  it("no members for the role falls back to a role broadcast with no assignee", () => {
    assert.equal(selectAssignee({ role: "tester", members: [], onCall: [], loads: new Map(), at: NOON_UTC }).via, "role_broadcast");
  });
  it("ties break deterministically by id", () => {
    const a = selectAssignee({
      role: "pm", members: [member("b", "pm"), member("a", "pm")], onCall: [], loads: new Map(), at: NOON_UTC,
    });
    assert.equal(a.assigneeId, "a");
  });
  it("an unknown timezone counts as outside working hours", () => {
    assert.equal(isWorkingHours("Not/AZone", NOON_UTC), false);
    assert.equal(isWorkingHours("UTC", NOON_UTC), true);
  });
});
