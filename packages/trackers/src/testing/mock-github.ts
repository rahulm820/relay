// A local stand-in for api.github.com, covering the endpoints GitHubProvider uses. Test-only. Tokens used with it are fake.
// It behaves like GitHub where tests depend on it: issues get sequential numbers and github.com URLs, search matches
// on the body, and requests without a bearer token are refused. It can also misbehave on demand: fail a request,
// rate limit it, accept a create and then drop the connection (the outcome-unknown case), or hide new issues from
// search for a while (index lag).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockIssue {
  id: number;
  number: number;
  repo: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  /** False while "index lag" is on: the issue exists but search cannot see it yet. */
  searchable: boolean;
}

/** What the mock saw. The Authorization header is reduced to a boolean: tokens are never stored. */
export interface GitHubRequest { method: string; path: string; query: string; body: unknown; authed: boolean }

export type RouteKind = "create" | "read" | "update" | "comment" | "search";

export interface Fault {
  /** Answer with this status instead of doing the work. */
  status?: number;
  headers?: Record<string, string>;
  /** Do the work (create the issue), then close the connection without answering. The caller sees a network error. */
  acceptThenDrop?: boolean;
}

const ISSUES = /^\/repos\/([^/]+)\/([^/]+)\/issues$/;
const ISSUE = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
const COMMENTS = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/;

export class MockGitHub {
  readonly issues: MockIssue[] = [];
  readonly requests: GitHubRequest[] = [];
  /** While true, issues created from now on stay out of search results (until revealSearch). */
  hideNewFromSearch = false;
  /** When set, only this bearer token is accepted. Otherwise any non-empty token is. */
  expectedToken: string | undefined;
  url = "";
  private nextNumber = 1;
  private faults: { kind: RouteKind; fault: Fault }[] = [];
  private server!: Server;

  /** Queues a fault for the next request of this kind (first in, first out). */
  fail(kind: RouteKind, fault: Fault): void { this.faults.push({ kind, fault }); }
  revealSearch(): void { for (const i of this.issues) i.searchable = true; this.hideNewFromSearch = false; }
  reset(): void { this.issues.length = 0; this.requests.length = 0; this.faults = []; this.hideNewFromSearch = false; this.nextNumber = 1; }
  /** Issue-creating requests the mock received (including ones it then dropped). */
  get createRequests(): GitHubRequest[] { return this.requests.filter((r) => r.method === "POST" && ISSUES.test(r.path)); }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> { return new Promise((r) => { this.server.closeAllConnections(); this.server.close(() => r()); }); }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  }
  private take(kind: RouteKind): Fault | undefined {
    const i = this.faults.findIndex((f) => f.kind === kind);
    return i >= 0 ? this.faults.splice(i, 1)[0]!.fault : undefined;
  }
  private view(i: MockIssue) {
    return { id: i.id, number: i.number, html_url: `https://github.com/${i.repo}/issues/${i.number}`, state: i.state, title: i.title, body: i.body, labels: i.labels.map((name) => ({ name })) };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    const header = String(req.headers.authorization ?? "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const authed = bearer !== "" && (this.expectedToken === undefined || bearer === this.expectedToken);
    this.requests.push({ method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : undefined, authed });
    if (!authed) return this.json(res, 401, { message: "Bad credentials" });

    const path = url.pathname;
    let kind: RouteKind | undefined;
    if (method === "POST" && ISSUES.test(path)) kind = "create";
    else if (method === "GET" && ISSUE.test(path)) kind = "read";
    else if (method === "PATCH" && ISSUE.test(path)) kind = "update";
    else if (method === "POST" && COMMENTS.test(path)) kind = "comment";
    else if (method === "GET" && path === "/search/issues") kind = "search";
    if (!kind) return this.json(res, 404, { message: "Not Found" });

    const fault = this.take(kind);
    if (fault?.status !== undefined) return this.json(res, fault.status, { message: "mock fault" }, fault.headers);

    const body = raw ? JSON.parse(raw) : {};
    if (kind === "create") {
      const m = ISSUES.exec(path)!;
      const issue: MockIssue = {
        id: 9_000_000 + this.nextNumber, number: this.nextNumber++, repo: `${m[1]}/${m[2]}`, title: String(body.title ?? ""), body: String(body.body ?? ""),
        state: "open", labels: Array.isArray(body.labels) ? body.labels.map(String) : [], searchable: !this.hideNewFromSearch,
      };
      this.issues.push(issue);
      if (fault?.acceptThenDrop) { res.socket?.destroy(); return; }
      return this.json(res, 201, this.view(issue));
    }
    if (kind === "read" || kind === "update") {
      const m = ISSUE.exec(path)!;
      const issue = this.issues.find((i) => i.repo === `${m[1]}/${m[2]}` && i.number === Number(m[3]));
      if (!issue) return this.json(res, 404, { message: "Not Found" });
      if (kind === "update") {
        if (body.state === "open" || body.state === "closed") issue.state = body.state;
        if (typeof body.title === "string") issue.title = body.title;
        if (typeof body.body === "string") issue.body = body.body;
        if (Array.isArray(body.labels)) issue.labels = body.labels.map(String);
      }
      return this.json(res, 200, this.view(issue));
    }
    if (kind === "comment") return this.json(res, 201, { id: 1 });

    // search: `repo:o/r is:issue in:body "<term>"`. Only the repo and the quoted term matter here.
    const q = url.searchParams.get("q") ?? "";
    const repo = /repo:(\S+)/.exec(q)?.[1];
    const term = /"([^"]+)"/.exec(q)?.[1];
    const items = this.issues.filter((i) => i.searchable && (!repo || i.repo === repo) && (!term || i.body.includes(term)));
    return this.json(res, 200, { total_count: items.length, incomplete_results: false, items: items.map((i) => this.view(i)) });
  }
}
