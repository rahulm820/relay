import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ackText, cleanClarificationItems, refusalText, statusText, ticketRef } from "./index.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("templates", () => {
  it("references are short, stable and derived from the ticket id", () => {
    assert.equal(ticketRef(ID), "REL-0F8FAD5B");
  });
  it("ack lists every ticket; sensitive tickets add a safety line", () => {
    assert.equal(ackText(["REL-1", "REL-2"], false), "Thanks, we've received your report and logged it as REL-1, REL-2. A team member will follow up here.");
    assert.match(ackText(["REL-1"], true), /don't send passwords, card numbers or one-time codes/);
    assert.doesNotMatch(ackText(["REL-1"], false), /passwords/);
  });
  it("status updates exist for exactly the notifying statuses", () => {
    for (const s of ["in_progress", "resolved", "reopened"] as const) assert.match(statusText(s, "REL-1", []), /REL-1/);
    assert.match(statusText("needs_info", "REL-1", ["app version", "device model"]), /app version and device model/);
    assert.match(statusText("needs_info", "REL-1", []), /tell us more/);
    for (const s of ["received", "triaged", "assigned", "in_review", "escalated", "quarantined", "closed"] as const) assert.throws(() => statusText(s, "REL-1", []), /no client template/);
  });
  it("the refusal is polite and does not repeat anything the client wrote", () => {
    assert.match(refusalText(), /only for reporting problems/);
  });
  it("all templates are plain text: no markup characters", () => {
    for (const text of [ackText(["REL-1"], true), refusalText(), statusText("resolved", "REL-1", []), statusText("needs_info", "REL-1", ["a b"])]) assert.doesNotMatch(text, /[*_`<>[\]]/);
  });
});

describe("cleanClarificationItems", () => {
  it("turns labels into phrases, caps count and length, strips markup, dedupes", () => {
    assert.deepEqual(cleanClarificationItems(["app_version", "device-model", "third thing"]), ["app version", "device model"]);
    const stripped = cleanClarificationItems(["<b>bold</b> [x](http://evil) `code`"])[0]!;
    assert.doesNotMatch(stripped, /[<>[\]()`:/]/);
    const long = cleanClarificationItems(["x".repeat(500)])[0]!;
    assert.equal(long.length, 60);
    assert.deepEqual(cleanClarificationItems(["a", "a", "b"]), ["a", "b"]);
    assert.deepEqual(cleanClarificationItems(["", "   ", "!!!"]), []);
  });
  it("leaves nothing that could mention, link or format", () => {
    const out = cleanClarificationItems(["@everyone", "https://evil.example/x?y=1"]).join(" ");
    assert.doesNotMatch(out, /[@:/?=]/);
  });
});
