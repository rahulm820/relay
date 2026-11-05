// GitHubProvider (Issue #9): issues REST v3 calls with a least-privilege token (issues:write + metadata:read).
// The token is passed in once and never logged; errors carry only a stable TrackerError code.
import {
  TrackerError,
  parseRepoRef,
  type ExternalIssue,
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
  number: number;
  html_url: string;
  state?: "open" | "closed";
  labels?: ({ name?: string } | string)[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

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

/** Maps an HTTP status to a TrackerError. Response bodies are not copied into the error. */
export function statusError(res: Response): TrackerError {
  const rateLimited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
  if (rateLimited) return new TrackerError("rate_limited", "GitHub rate limit");
  if (res.status === 401) return new TrackerError("auth", "GitHub rejected the token");
  if (res.status === 403) return new TrackerError("forbidden", "GitHub denied access (token scope or repo permission)");
  if (res.status === 404) return new TrackerError("not_found", "GitHub repository or issue not found");
  if (res.status === 422) return new TrackerError("validation", "GitHub rejected the request as invalid");
  if (res.status >= 500) return new TrackerError("server", `GitHub server error (${res.status})`);
  return new TrackerError("validation", `GitHub returned HTTP ${res.status}`);
}
