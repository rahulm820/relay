// GitHubProvider (Issue #9): issues REST v3 calls with a least-privilege token (issues:write + metadata:read).
// The token is passed in once and never logged; errors carry only a stable TrackerError code.
import {
  TrackerError,
  parseRepoRef,
  type ExternalIssue,
  type FoundIssue,
  type IssueStatus,
  type NewIssue,
  type TrackerProvider,
  type WebhookEvent,
} from "./provider.js";

export interface GitHubProviderOptions {
  token: string;
  /** Override for GitHub Enterprise or tests. Default https://api.github.com */
  baseUrl?: string;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

interface GitHubIssueJson {
  id: number;
  title?: string;
  body?: string | null;
  pull_request?: unknown;
  number: number;
  html_url: string;
  state?: "open" | "closed";
  labels?: ({ name?: string } | string)[];
}

interface GitHubContentJson {
  content?: string;
  encoding?: string;
  path?: string;
}

interface GitHubCommitJson {
  sha?: string;
  commit?: { message?: string; author?: { date?: string } };
}

/** One retrieved file or document, truncated to a prompt-safe size (#13). */
export interface RepoContextFile {
  path: string;
  content: string;
}

export interface RepoContextIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
}

export interface RepoContextCommit {
  sha: string;
  message: string;
  date: string;
}

/** Read-only repository context for code-aware drafting (Issue #13, §4.10.2). GitHubProvider implements it. */
export interface RepoContext {
  files: RepoContextFile[];
  docs: RepoContextFile[];
  issues: RepoContextIssue[];
  commits: RepoContextCommit[];
}

/** What the github.draft handler needs: context retrieval only. Injected in tests. */
export interface RepoContextProvider {
  retrieveContext(repo: string, query: string, opts?: { maxFiles?: number }): Promise<RepoContext>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Per-file cap so a large file cannot blow the prompt budget. */
const MAX_FILE_CHARS = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GitHubProvider implements TrackerProvider {
  readonly provider = "github" as const;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GitHubProviderOptions) {
    if (!opts.token) throw new TrackerError("auth", "GitHub token is empty");
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createIssue(repo: string, issue: NewIssue): Promise<ExternalIssue> {
    const r = parseRepoRef(repo);
    const json = await this.request<GitHubIssueJson>("POST", `/repos/${r.owner}/${r.name}/issues`, {
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    });
    return toExternal(json);
  }

  async updateIssue(repo: string, number: number, patch: Partial<NewIssue> & { state?: "open" | "closed" }): Promise<ExternalIssue> {
    const r = parseRepoRef(repo);
    const json = await this.request<GitHubIssueJson>("PATCH", `/repos/${r.owner}/${r.name}/issues/${number}`, patch);
    return toExternal(json);
  }

  async addComment(repo: string, number: number, body: string): Promise<{ id: string }> {
    const r = parseRepoRef(repo);
    const json = await this.request<{ id: number }>("POST", `/repos/${r.owner}/${r.name}/issues/${number}/comments`, { body });
    return { id: String(json.id) };
  }

  async linkIssues(repo: string, from: number, to: number): Promise<void> {
    await this.addComment(repo, from, `Related to #${to}`);
    await this.addComment(repo, to, `Related to #${from}`);
  }

  async getStatus(repo: string, number: number): Promise<IssueStatus> {
    const r = parseRepoRef(repo);
    const json = await this.request<GitHubIssueJson>("GET", `/repos/${r.owner}/${r.name}/issues/${number}`);
    return {
      state: json.state === "closed" ? "closed" : "open",
      labels: (json.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    };
  }

  async findIssueByTicket(repo: string, ticketId: string): Promise<FoundIssue | null> {
    const r = parseRepoRef(repo);
    // The ticket id is a UUID and is validated before it goes into a search query.
    if (!UUID.test(ticketId)) throw new TrackerError("validation", "ticket id must be a UUID");
    const q = encodeURIComponent(`repo:${r.owner}/${r.name} is:issue in:body "${ticketId}"`);
    const json = await this.request<{ items?: GitHubIssueJson[] }>("GET", `/search/issues?q=${q}&per_page=5`);
    // Search is fuzzy: only accept an issue whose body really carries the exact id, and the oldest if several.
    const hits = (json.items ?? []).filter((i) => !i.pull_request && typeof i.body === "string" && i.body.includes(ticketId));
    const first = hits.sort((a, b) => a.number - b.number)[0];
    return first ? { ...toExternal(first), state: first.state === "closed" ? "closed" : "open" } : null;
  }

  /**
   * Read-only context for code-aware drafting (#13): files matching the query (code search + contents),
   * the README, open/closed issues and recent commits. A missing README or an empty code search is
   * normal and yields empty lists; a failed endpoint otherwise propagates as a TrackerError so the
   * outbox retries. Contents are read with the token's `contents:read` scope only.
   */
  async retrieveContext(repo: string, query: string, opts: { maxFiles?: number } = {}): Promise<RepoContext> {
    const r = parseRepoRef(repo);
    const base = `/repos/${r.owner}/${r.name}`;
    const maxFiles = opts.maxFiles ?? 5;

    // 1. Relevant source files: code search for paths, then read each one.
    let paths: string[] = [];
    try {
      const q = encodeURIComponent(`repo:${r.owner}/${r.name} ${query}`.trim());
      const search = await this.request<{ items?: { path?: string }[] }>("GET", `/search/code?q=${q}&per_page=${maxFiles * 2}`);
      paths = [...new Set((search.items ?? []).map((i) => i.path).filter((p): p is string => typeof p === "string" && p.length > 0))].slice(0, maxFiles);
    } catch (err) {
      // No matches (or a query GitHub rejects) is not an error: draft from what the other sources give.
      if (!(err instanceof TrackerError && (err.code === "not_found" || err.code === "validation"))) throw err;
    }
    const files: RepoContextFile[] = [];
    for (const path of paths) {
      try {
        const file = await this.request<GitHubContentJson>("GET", `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
        if (typeof file.content === "string") files.push({ path, content: decodeContent(file.content, file.encoding) });
      } catch (err) {
        if (!(err instanceof TrackerError && err.code === "not_found")) throw err; // file vanished between search and read
      }
    }

    // 2. Documentation: the repo README, when there is one.
    let docs: RepoContextFile[] = [];
    try {
      const readme = await this.request<GitHubContentJson>("GET", `${base}/readme`);
      if (typeof readme.content === "string") docs = [{ path: readme.path ?? "README.md", content: decodeContent(readme.content, readme.encoding) }];
    } catch (err) {
      if (!(err instanceof TrackerError && err.code === "not_found")) throw err;
    }

    // 3. Open and closed issues (pull requests filtered out) — also the duplicate-detection corpus.
    const issueList = await this.request<GitHubIssueJson[]>("GET", `${base}/issues?state=all&per_page=20&sort=updated`);
    const issues: RepoContextIssue[] = issueList
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title ?? "", state: i.state === "closed" ? "closed" : "open", url: i.html_url }));

    // 4. Recent commits.
    const commitList = await this.request<GitHubCommitJson[]>("GET", `${base}/commits?per_page=10`);
    const commits: RepoContextCommit[] = commitList
      .filter((c): c is GitHubCommitJson & { sha: string } => typeof c.sha === "string")
      .map((c) => ({
        sha: c.sha,
        message: (c.commit?.message ?? "").split("\n")[0] ?? "",
        date: c.commit?.author?.date ?? "",
      }));

    return { files, docs, issues, commits };
  }

  onWebhook(_event: string, _payload: unknown): WebhookEvent | null {
    throw new TrackerError("not_implemented", "GitHub webhooks are handled in Issue #21");
  }

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "relay-tracker-sync",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new TrackerError("timeout", "GitHub request timed out");
      throw new TrackerError("network", "GitHub request failed before a response");
    }
    if (res.ok) return (await res.json()) as T;
    throw statusError(res);
  }
}

function toExternal(json: GitHubIssueJson): ExternalIssue {
  return { id: String(json.id), number: json.number, url: json.html_url };
}

/** Decodes a GitHub contents payload (base64 by default) and truncates it for the prompt. */
function decodeContent(content: string, encoding: string | undefined): string {
  const text = encoding === "base64" ? Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8") : content;
  return text.slice(0, MAX_FILE_CHARS);
}

/** Maps an HTTP status to a TrackerError. Response bodies are not copied into the error. */
export function statusError(res: Response): TrackerError {
  const rateLimited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
  if (rateLimited) return new TrackerError("rate_limited", "GitHub rate limit", retryAfterMs(res));
  if (res.status === 401) return new TrackerError("auth", "GitHub rejected the token");
  if (res.status === 403) return new TrackerError("forbidden", "GitHub denied access (token scope or repo permission)");
  if (res.status === 404) return new TrackerError("not_found", "GitHub repository or issue not found");
  if (res.status === 422) return new TrackerError("validation", "GitHub rejected the request as invalid");
  if (res.status >= 500) return new TrackerError("server", `GitHub server error (${res.status})`);
  return new TrackerError("validation", `GitHub returned HTTP ${res.status}`);
}

/** Milliseconds GitHub asked us to wait: `Retry-After` (seconds) or the `X-RateLimit-Reset` epoch. Undefined if absent. */
export function retryAfterMs(res: Response, now: number = Date.now()): number | undefined {
  const retry = Number(res.headers.get("retry-after"));
  if (res.headers.has("retry-after") && Number.isFinite(retry) && retry >= 0) return Math.round(retry * 1000);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (res.headers.has("x-ratelimit-reset") && Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return undefined;
}
