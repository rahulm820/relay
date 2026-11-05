import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as browser from "./browser.js";

test("browser entry exposes the shared contracts", () => {
  assert.ok(browser.TICKET_STATUSES.includes("quarantined"));
  assert.equal(browser.canTransition("received", "triaged"), true);
  assert.ok(browser.TicketDtoSchema);
});

test("browser entry and everything it re-exports import no node: modules", () => {
  for (const f of ["browser", "enums", "state-machine", "contracts"]) {
    const src = readFileSync(new URL(`./${f}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from "node:/, `${f}.ts must stay browser-safe`);
  }
});
