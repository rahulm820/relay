// The mock is a test double that other suites rely on, so it is tested through the real GitHubProvider.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { GitHubProvider, TrackerError } from "./index.js";
import { MockGitHub } from "./testing/mock-github.js";

const TICKET = "0a1b2c3d-0000-4000-8000-000000000001";
const body = `Card payments return 500\n\n---\n_Created from Relay ticket \`${TICKET}\`._`;
let gh: MockGitHub;
let provider: GitHubProvider;
before(async () => { gh = new MockGitHub(); await gh.start(); provider = new GitHubProvider({ token: "fake-token", baseUrl: gh.url, timeoutMs: 2000 }); });
after(async () => { await gh.stop(); });
beforeEach(() => gh.reset());

describe("MockGitHub through GitHubProvider", () => {
  it("creates issues with sequential numbers, github.com URLs, labels, and reads them back", async () => {
    const a = await provider.createIssue("acme/app", { title: "One", body, labels: ["bug"] });
    const b = await provider.createIssue("acme/app", { title: "Two", body: "x", labels: [] });
    assert.deepEqual([a.number, b.number], [1, 2]);
    assert.equal(a.url, "https://github.com/acme/app/issues/1");
    assert.deepEqual(await provider.getStatus("acme/app", 1), { state: "open", labels: ["bug"] });
    await provider.updateIssue("acme/app", 1, { state: "closed" });
    assert.equal((await provider.getStatus("acme/app", 1)).state, "closed");
    await assert.rejects(provider.getStatus("acme/app", 99), (e: TrackerError) => e.code === "not_found");
  });

  it("searches by repo and the ticket id in the body, and findIssueByTicket uses it", async () => {
    await provider.createIssue("acme/app", { title: "Mine", body, labels: [] });
    await provider.createIssue("acme/other", { title: "Other repo", body, labels: [] });
    const found = await provider.findIssueByTicket("acme/app", TICKET);
    assert.equal(found?.number, 1);
    assert.equal(found?.state, "open");
    assert.equal(await provider.findIssueByTicket("acme/app", "0a1b2c3d-0000-4000-8000-000000000002"), null);
  });

  it("refuses requests without a token, and never stores one", async () => {
    gh.expectedToken = "the-right-token";
    await assert.rejects(provider.createIssue("acme/app", { title: "x", body: "x", labels: [] }), (e: TrackerError) => e.code === "auth");
    assert.equal(gh.issues.length, 0);
    assert.ok(!JSON.stringify(gh.requests).includes("fake-token"));
    assert.equal(gh.requests[0]!.authed, false);
    gh.expectedToken = undefined;
  });

  it("injects a failure once, then behaves", async () => {
    gh.fail("create", { status: 503 });
    await assert.rejects(provider.createIssue("acme/app", { title: "x", body, labels: [] }), (e: TrackerError) => e.code === "server");
    assert.equal(gh.issues.length, 0, "a failed create creates nothing");
    assert.equal((await provider.createIssue("acme/app", { title: "x", body, labels: [] })).number, 1);
  });

  it("rate limits with a Retry-After the provider surfaces", async () => {
    gh.fail("create", { status: 403, headers: { "retry-after": "17", "x-ratelimit-remaining": "0" } });
    await assert.rejects(provider.createIssue("acme/app", { title: "x", body, labels: [] }), (e: TrackerError) => e.code === "rate_limited" && e.retryAfterMs === 17_000);
  });

  it("can accept a create and then drop the connection: the caller sees a network error but the issue exists", async () => {
    gh.fail("create", { acceptThenDrop: true });
    await assert.rejects(provider.createIssue("acme/app", { title: "x", body, labels: [] }), (e: TrackerError) => e.code === "network");
    assert.equal(gh.issues.length, 1);
    assert.equal(gh.createRequests.length, 1);
  });

  it("hides new issues from search while index lag is on, then reveals them", async () => {
    gh.hideNewFromSearch = true;
    await provider.createIssue("acme/app", { title: "x", body, labels: [] });
    assert.equal(await provider.findIssueByTicket("acme/app", TICKET), null, "exists, but search cannot see it yet");
    gh.revealSearch();
    assert.equal((await provider.findIssueByTicket("acme/app", TICKET))?.number, 1);
  });
});
