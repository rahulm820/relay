import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider, TrackerError, parseRepoRef, retryAfterMs } from "./index.js";

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/** Fake fetch: returns the scripted response (or throws the scripted error) and records the call. */
function fakeFetch(respond: () => Response | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = respond();
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const TOKEN = "ghp_SUPERSECRETTOKEN123456789";
const issue = { title: "Checkout fails", body: "body text", labels: ["bug", "priority:p2"] };

test("createIssue posts to the repo with auth and returns number and URL", async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    new Response(JSON.stringify({ id: 99, number: 42, html_url: "https://github.com/acme/app/issues/42" }), { status: 201 }));
  const gh = new GitHubProvider({ token: TOKEN, fetchImpl });
  const out = await gh.createIssue("acme/app", issue);
  assert.deepEqual(out, { id: "99", number: 42, url: "https://github.com/acme/app/issues/42" });
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/app/issues");
  assert.equal(calls[0]?.headers["authorization"], `Bearer ${TOKEN}`);
  assert.deepEqual(calls[0]?.body, issue);
});

test("the token never appears in the URL or in a thrown error message", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("nope", { status: 401 }));
  const gh = new GitHubProvider({ token: TOKEN, fetchImpl });
  await assert.rejects(gh.createIssue("acme/app", issue), (err: unknown) => {
    assert.ok(err instanceof TrackerError);
    assert.equal(err.code, "auth");
    assert.doesNotMatch(String(err.message), new RegExp(TOKEN));
    return true;
  });
});

const statusCases: [string, Response | Error, string][] = [
  ["403 forbidden", new Response("{}", { status: 403 }), "forbidden"],
  ["403 with exhausted rate limit", new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "rate_limited"],
  ["429", new Response("{}", { status: 429 }), "rate_limited"],
  ["401", new Response("{}", { status: 401 }), "auth"],
  ["404 missing repo", new Response("{}", { status: 404 }), "not_found"],
  ["422", new Response("{}", { status: 422 }), "validation"],
  ["503", new Response("{}", { status: 503 }), "server"],
  ["network failure", new TypeError("fetch failed"), "network"],
  ["timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" }), "timeout"],
];

for (const [label, response, code] of statusCases) {
  test(`maps ${label} to ${code}`, async () => {
    const { fetchImpl } = fakeFetch(() => response);
    const gh = new GitHubProvider({ token: TOKEN, fetchImpl });
    await assert.rejects(gh.createIssue("acme/app", issue), (err: unknown) => err instanceof TrackerError && err.code === code);
  });
}

test("an invalid repo_ref is rejected before any request is made", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response("{}", { status: 201 }));
  const gh = new GitHubProvider({ token: TOKEN, fetchImpl });
  await assert.rejects(gh.createIssue("not a repo", issue), (err: unknown) => err instanceof TrackerError && err.code === "invalid_repo");
  assert.equal(calls.length, 0);
});

test("parseRepoRef accepts owner/name and nothing else", () => {
  assert.deepEqual(parseRepoRef("acme/app.web"), { owner: "acme", name: "app.web" });
  assert.throws(() => parseRepoRef("acme"), TrackerError);
  assert.throws(() => parseRepoRef("acme/app/extra"), TrackerError);
});

test("getStatus reads the state and label names", async () => {
  const { fetchImpl } = fakeFetch(() => new Response(JSON.stringify({ id: 1, number: 7, html_url: "u", state: "closed", labels: [{ name: "bug" }] }), { status: 200 }));
  const gh = new GitHubProvider({ token: TOKEN, fetchImpl });
  assert.deepEqual(await gh.getStatus("acme/app", 7), { state: "closed", labels: ["bug"] });
});

test("onWebhook is not implemented before Issue #21", () => {
  const gh = new GitHubProvider({ token: TOKEN, fetchImpl: fakeFetch(() => new Response("{}")).fetchImpl });
  assert.throws(() => gh.onWebhook("issues", {}), (err: unknown) => err instanceof TrackerError && err.code === "not_implemented");
});

const TICKET = "0a1b2c3d-0000-4000-8000-000000000001";
const search = (items: unknown[]) => new Response(JSON.stringify({ items }), { status: 200 });

test("findIssueByTicket searches the repo for the ticket id and returns the matching issue", async () => {
  const { fetchImpl, calls } = fakeFetch(() => search([{ id: 7, number: 12, html_url: "https://github.com/acme/app/issues/12", state: "closed", body: `text\n_Created from Relay ticket \`${TICKET}\`._` }]));
  const found = await new GitHubProvider({ token: TOKEN, fetchImpl }).findIssueByTicket("acme/app", TICKET);
  assert.deepEqual(found, { id: "7", number: 12, url: "https://github.com/acme/app/issues/12", state: "closed" });
  assert.equal(calls[0]!.method, "GET");
  const q = decodeURIComponent(new URL(calls[0]!.url).searchParams.get("q")!);
  assert.match(q, /repo:acme\/app/);
  assert.ok(q.includes(TICKET));
});

test("findIssueByTicket ignores fuzzy hits, pull requests and returns the oldest real match", async () => {
  const hit = (number: number, body: string, extra: object = {}) => ({ id: number, number, html_url: `https://github.com/acme/app/issues/${number}`, state: "open", body, ...extra });
  const { fetchImpl } = fakeFetch(() => search([
    hit(30, "mentions another ticket 0a1b2c3d-0000-4000-8000-000000000002"),
    hit(25, `Relay ticket ${TICKET}`, { pull_request: {} }),
    hit(22, `Relay ticket ${TICKET}`),
    hit(21, `Relay ticket ${TICKET}`),
  ]));
  assert.equal((await new GitHubProvider({ token: TOKEN, fetchImpl }).findIssueByTicket("acme/app", TICKET))?.number, 21);
});

test("findIssueByTicket returns null when nothing matches, and rejects a non-UUID before any request", async () => {
  const { fetchImpl, calls } = fakeFetch(() => search([]));
  const gh = new GitHubProvider({ token: TOKEN, fetchImpl });
  assert.equal(await gh.findIssueByTicket("acme/app", TICKET), null);
  await assert.rejects(gh.findIssueByTicket("acme/app", 'x" OR repo:other/secret'), (e: TrackerError) => e.code === "validation");
  assert.equal(calls.length, 1, "the bad id never reached the network");
});

test("a rate limit carries the wait GitHub asked for", async () => {
  const limited = (headers: Record<string, string>) => fakeFetch(() => new Response("{}", { status: 403, headers })).fetchImpl;
  const a = await new GitHubProvider({ token: TOKEN, fetchImpl: limited({ "retry-after": "30" }) }).getStatus("acme/app", 1).catch((e: TrackerError) => e);
  assert.equal((a as TrackerError).code, "rate_limited");
  assert.equal((a as TrackerError).retryAfterMs, 30_000);
  const b = await new GitHubProvider({ token: TOKEN, fetchImpl: fakeFetch(() => new Response("{}", { status: 429 })).fetchImpl }).getStatus("acme/app", 1).catch((e: TrackerError) => e);
  assert.equal((b as TrackerError).retryAfterMs, undefined);
});

test("retryAfterMs prefers Retry-After and falls back to the reset epoch", () => {
  const res = (h: Record<string, string>) => new Response("", { headers: h });
  assert.equal(retryAfterMs(res({ "retry-after": "5" })), 5000);
  assert.equal(retryAfterMs(res({ "x-ratelimit-reset": "1000" }), 990_000), 10_000);
  assert.equal(retryAfterMs(res({ "x-ratelimit-reset": "1000" }), 2_000_000), 0);
  assert.equal(retryAfterMs(res({})), undefined);
  assert.equal(retryAfterMs(res({ "retry-after": "soon" })), undefined);
});

// --- retrieveContext (#13): read-only context for code-aware drafting -----------------------------

const b64 = (s: string) => Buffer.from(s).toString("base64");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Routes each request by URL; unmatched URLs 404. Records every URL called. */
function routedFetch(routes: [RegExp, () => Response][]) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const hit = routes.find(([re]) => re.test(String(url)));
    return hit ? hit[1]() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

test("retrieveContext gathers files, docs, issues and commits, filtering pull requests", async () => {
  const { fetchImpl, urls } = routedFetch([
    [/\/search\/code/, () => json({ items: [{ path: "src/checkout.ts" }, { path: "src/checkout.ts" }, { path: "src/cart.ts" }] })],
    [/\/contents\/src\/checkout\.ts/, () => json({ content: b64("export const pay = () => 500;"), encoding: "base64" })],
    [/\/contents\/src\/cart\.ts/, () => json({ content: b64("cart code"), encoding: "base64" })],
    [/\/readme/, () => json({ path: "README.md", content: b64("# App"), encoding: "base64" })],
    [/\/issues/, () => json([
      { number: 5, title: "Checkout 500", state: "open", html_url: "u5" },
      { number: 6, title: "Refactor cart", state: "open", html_url: "u6", pull_request: {} },
      { number: 7, title: "Old checkout bug", state: "closed", html_url: "u7" },
    ])],
    [/\/commits/, () => json([{ sha: "abcdef123456", commit: { message: "fix checkout\n\nlong body", author: { date: "2026-01-01T00:00:00Z" } } }])],
  ]);
  const gh = new GitHubProvider({ token: TOKEN, fetchImpl });

  const ctx = await gh.retrieveContext("acme/app", 'checkout 500 "quoted"');

  assert.deepEqual(ctx.files.map((f) => f.path), ["src/checkout.ts", "src/cart.ts"], "duplicate search hits collapse");
  assert.equal(ctx.files[0]?.content, "export const pay = () => 500;");
  assert.deepEqual(ctx.docs, [{ path: "README.md", content: "# App" }]);
  assert.deepEqual(ctx.issues, [
    { number: 5, title: "Checkout 500", state: "open", url: "u5" },
    { number: 7, title: "Old checkout bug", state: "closed", url: "u7" },
  ], "pull requests are excluded");
  assert.deepEqual(ctx.commits, [{ sha: "abcdef123456", message: "fix checkout", date: "2026-01-01T00:00:00Z" }]);
  assert.match(urls[0] ?? "", /\/search\/code\?q=repo%3Aacme%2Fapp/);
  assert.ok(urls.every((u) => !u.includes(TOKEN)), "the token never appears in a URL");
});

test("retrieveContext tolerates an empty code search and a missing README", async () => {
  const { fetchImpl } = routedFetch([
    [/\/search\/code/, () => json({ items: [] })],
    [/\/readme/, () => new Response("not found", { status: 404 })],
    [/\/issues/, () => json([])],
    [/\/commits/, () => json([])],
  ]);
  const ctx = await new GitHubProvider({ token: TOKEN, fetchImpl }).retrieveContext("acme/app", "nothing here");
  assert.deepEqual(ctx, { files: [], docs: [], issues: [], commits: [] });
});

test("retrieveContext propagates a failed endpoint as a TrackerError so the outbox retries", async () => {
  const { fetchImpl } = routedFetch([
    [/\/search\/code/, () => new Response("boom", { status: 503 })],
  ]);
  await assert.rejects(
    new GitHubProvider({ token: TOKEN, fetchImpl }).retrieveContext("acme/app", "checkout"),
    (err: unknown) => err instanceof TrackerError && err.code === "server",
  );
});
