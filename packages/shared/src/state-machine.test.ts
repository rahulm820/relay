// Structural invariants of the ticket state machine. They hold for any edit of the table, so adding or removing a
// transition cannot silently break the lifecycle (every status reachable, nothing stuck, no self-loops).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TICKET_STATUSES, type TicketStatus } from "./enums.js";
import { IllegalTransitionError, TICKET_TRANSITIONS, assertTransition, canTransition } from "./state-machine.js";

const statuses = [...TICKET_STATUSES] as TicketStatus[];

describe("ticket state machine: structure", () => {
  it("defines an entry for every status and no others", () => {
    assert.deepEqual(Object.keys(TICKET_TRANSITIONS).sort(), [...statuses].sort());
  });

  it("only moves to real statuses, never to itself, never listing a target twice", () => {
    for (const [from, targets] of Object.entries(TICKET_TRANSITIONS)) {
      for (const to of targets) assert.ok(statuses.includes(to), `${from} -> ${to} is not a status`);
      assert.ok(!targets.includes(from as TicketStatus), `${from} lists itself`);
      assert.equal(new Set(targets).size, targets.length, `${from} lists a target twice`);
    }
  });

  it("every status is reachable from `received`, the only entry point", () => {
    const seen = new Set<TicketStatus>(["received"]);
    const queue: TicketStatus[] = ["received"];
    while (queue.length) for (const next of TICKET_TRANSITIONS[queue.shift()!]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    assert.deepEqual([...seen].sort(), [...statuses].sort());
    const hasIncoming = (s: TicketStatus) => statuses.some((from) => TICKET_TRANSITIONS[from].includes(s));
    // `received` is re-entered only from quarantine (a human sending a held ticket back to the start).
    assert.deepEqual(statuses.filter((s) => !hasIncoming(s)), [], "every status can be entered");
  });

  it("no status is a dead end: each one has a way out", () => {
    for (const s of statuses) assert.ok(TICKET_TRANSITIONS[s].length > 0, `${s} has no exit`);
  });

  it("a finished ticket can only come back through `reopened`", () => {
    assert.deepEqual([...TICKET_TRANSITIONS.closed], ["reopened"]);
    assert.ok(TICKET_TRANSITIONS.resolved.includes("reopened") && TICKET_TRANSITIONS.resolved.includes("closed"));
    for (const from of statuses) {
      if (from !== "resolved" && from !== "closed") assert.ok(!TICKET_TRANSITIONS[from].includes("closed"), `${from} must not close directly`);
    }
  });

  it("a ticket cannot leave quarantine except to `received` or `triaged` (a human's decision)", () => {
    assert.deepEqual([...TICKET_TRANSITIONS.quarantined].sort(), ["received", "triaged"]);
  });

  it("canTransition agrees with the table for every pair, and assertTransition throws exactly when it is false", () => {
    for (const from of statuses) {
      for (const to of statuses) {
        const legal = TICKET_TRANSITIONS[from].includes(to);
        assert.equal(canTransition(from, to), legal, `${from} -> ${to}`);
        if (legal) assert.doesNotThrow(() => assertTransition(from, to));
        else assert.throws(() => assertTransition(from, to), (e: unknown) => e instanceof IllegalTransitionError && e.from === from && e.to === to);
      }
    }
  });
});
