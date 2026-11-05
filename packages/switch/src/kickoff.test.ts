import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildKickoff, roomDescription, roomMarker, roomName, sanitizeUntrusted } from "./index.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const base = { id: ID, title: "Needs human triage", summary: "", priority: "P3", category: "other", status: "quarantined", slaAckDue: null, ownerHandles: [] };

describe("room identity", () => {
  it("is deterministic and carries the full ticket id as the lookup marker", () => {
    assert.equal(roomName(ID), "relay-0f8fad5b");
    assert.equal(roomName(ID), roomName(ID));
    assert.ok(roomDescription(ID).includes(roomMarker(ID)));
    assert.equal(roomMarker(ID), `relay:ticket:${ID}`);
  });
});

describe("sanitizeUntrusted", () => {
  it("defuses mentions, markup, links, control characters and length", () => {
    const out = sanitizeUntrusted("hi @all @channel `x` <b>[click](http://evil)</b>\n\u0007\tdone", 200);
    assert.ok(!out.includes("@"));
    assert.ok(!/[`<>]/.test(out));
    assert.ok(!out.includes("]("));
    assert.ok(!/[\u0000-\u001f]/.test(out));
    assert.equal(sanitizeUntrusted("x".repeat(500), 50).length, 50);
  });
});

describe("buildKickoff", () => {
  it("shows priority, category, status, SLA and ticket id; says when nobody is assigned", () => {
    const text = buildKickoff({ ...base, slaAckDue: "2026-11-06T10:00:00.000Z" });
    for (const part of ["relay-0f8fad5b", "P3", "other", "quarantined", "Needs human triage", "2026-11-06T10:00:00.000Z", "Owner: not assigned yet", ID]) assert.ok(text.includes(part), part);
  });
  it("mentions owners only when they have safe chat handles", () => {
    const text = buildKickoff({ ...base, ownerHandles: ["dana.d", "bad handle", "evil@all"] });
    assert.ok(text.includes("Owner: @dana.d"));
    assert.ok(!text.includes("bad handle") && !text.includes("evil"));
  });
  it("includes a GitHub reference only when one exists", () => {
    assert.ok(!buildKickoff(base).includes("GitHub"));
    const text = buildKickoff({ ...base, github: { url: "https://github.com/o/r/issues/12", number: 12 } });
    assert.ok(text.includes("GitHub: https://github.com/o/r/issues/12 (#12)"));
  });
  it("neutralises untrusted title and summary", () => {
    const text = buildKickoff({ ...base, title: "pay @all now [here](http://x)", summary: "`rm` <script>" });
    assert.ok(!text.includes("@all") && !text.includes("](") && !text.includes("<script>"));
  });
});
