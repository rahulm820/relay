// A local stand-in for Switch, built from the contracts read in the Switch source (see the PR). Test-only.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded { method: string; path: string; body: any; cookie?: string; auth?: string }
interface MockRoom { id: string; name: string; description: string; bridge_id: string | null; external_channel_id: string | null; users: string[]; archived: boolean; agent_names: string[] }
interface Fault { status?: number; delayMs?: number; times: number }

export class MockSwitch {
  readonly email = "admin@example.test";
  readonly password = "mock-admin-password";
  readonly agents = new Map<string, { id: string; key: string }>();
  readonly rooms: MockRoom[] = [];
  readonly messages: { roomId: string; content: string; agentId: string }[] = [];
  readonly requests: Recorded[] = [];
  readonly knownUsers = new Set<string>();
  logins = 0;
  loginStatus: number | null = null;
  private sessions = new Set<string>();
  private faults = new Map<string, Fault>();
  private server!: Server;
  url = "";

  /** Next `times` requests to `METHOD /path-prefix` answer `status` and/or wait `delayMs` first. */
  fault(key: string, f: Omit<Fault, "times"> & { times?: number }): void { this.faults.set(key, { times: 1, ...f }); }
  expireSessions(): void { this.sessions.clear(); }
  get gatewayUrl(): string { return `${this.url}/gateway`; }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> { return new Promise((r) => { this.server.closeAllConnections(); this.server.close(() => r()); }); }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(body === undefined ? "" : JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    const body = raw ? JSON.parse(raw) : undefined;
    const cookie = req.headers.cookie;
    this.requests.push({ method: req.method ?? "", path: path + url.search, body, ...(cookie ? { cookie } : {}), ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });

    for (const [key, f] of this.faults) {
      const [m, prefix] = key.split(" ");
      if (m === req.method && path.startsWith(prefix!) && f.times > 0) {
        f.times--;
        if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
        if (f.status) return this.json(res, f.status, { detail: "injected" });
      }
    }

    if (req.method === "POST" && path === "/gateway/auth/login") {
      this.logins++;
      if (this.loginStatus) return this.json(res, this.loginStatus, { detail: "x" });
      if (body?.email !== this.email || body?.password !== this.password) return this.json(res, 401, { detail: "Invalid email or password" });
      const token = `tok-${randomUUID()}`;
      this.sessions.add(token);
      return this.json(res, 200, { ok: true }, { "set-cookie": `switch_auth=${token}; HttpOnly; Path=/; SameSite=lax` });
    }

    // agent API (Bearer agent key)
    const msg = path.match(/^\/agents\/([^/]+)\/message$/);
    if (req.method === "POST" && msg) {
      const agent = [...this.agents.values()].find((a) => a.id === msg[1]);
      if (!agent || req.headers.authorization !== `Bearer ${agent.key}`) return this.json(res, 401, { detail: "bad key" });
      if (!this.rooms.some((r) => r.id === body.room_id)) return this.json(res, 404, { detail: "no room" });
      this.messages.push({ roomId: body.room_id, content: body.content, agentId: agent.id });
      return this.json(res, 200, { ok: true, event_id: randomUUID() });
    }

    // gateway (cookie)
    if (!path.startsWith("/gateway/")) return this.json(res, 404, {});
    const token = /switch_auth=([^;]+)/.exec(cookie ?? "")?.[1];
    if (!token || !this.sessions.has(token)) return this.json(res, 401, { detail: "Not authenticated" });
    const sub = path.slice("/gateway".length);

    if (req.method === "GET" && sub === "/collaborations") {
      return this.json(res, 200, [{ bridge_id: "bridge-1", bridge_type: "mattermost", display_name: "Mattermost", status: "running", is_default: true }]);
    }
    if (req.method === "GET" && sub === "/agents") return this.json(res, 200, [...this.agents].map(([name, a]) => ({ id: a.id, name })));
    if (req.method === "POST" && sub === "/agents/register-other") {
      const existing = this.agents.get(body.name);
      if (existing && !body.overwrite) return this.json(res, 409, { detail: "exists" });
      const entry = { id: existing?.id ?? randomUUID(), key: `key-${randomUUID()}` };
      this.agents.set(body.name, entry);
      return this.json(res, 200, { id: entry.id, api_key: entry.key });
    }
    if (req.method === "GET" && sub === "/rooms") {
      const term = (url.searchParams.get("search") ?? "").toLowerCase();
      return this.json(res, 200, this.rooms.filter((r) => !r.archived && (r.name.toLowerCase().includes(term) || r.description.toLowerCase().includes(term)))
        .map((r) => ({ id: r.id, name: r.name, description: r.description, bridge_id: r.bridge_id, archived: false })));
    }
    if (req.method === "POST" && sub === "/rooms") {
      if (typeof body?.name !== "string" || typeof body?.description !== "string") return this.json(res, 422, {});
      const unknown = (body.agent_names ?? []).filter((n: string) => !this.agents.has(n));
      if (unknown.length) return this.json(res, 400, { detail: "Agents not found" });
      const room: MockRoom = {
        id: randomUUID(), name: body.name, description: body.description, bridge_id: body.bridge_id ?? "bridge-1",
        external_channel_id: `chan-${randomUUID().slice(0, 8)}`, users: [], archived: false, agent_names: body.agent_names ?? [],
      };
      this.rooms.push(room);
      return this.json(res, 201, { ...this.detail(room) });
    }
    const users = sub.match(/^\/rooms\/([^/]+)\/users$/);
    if (req.method === "POST" && users) {
      const room = this.rooms.find((r) => r.id === users[1]);
      if (!room) return this.json(res, 404, {});
      for (const n of body.user_names as string[]) if (this.knownUsers.has(n) && !room.users.includes(n)) room.users.push(n);
      return this.json(res, 200, this.detail(room));
    }
    const archive = sub.match(/^\/rooms\/([^/]+)\/archive$/);
    if (req.method === "POST" && archive) {
      const room = this.rooms.find((r) => r.id === archive[1]);
      if (!room) return this.json(res, 404, {});
      room.archived = true;
      res.writeHead(204).end();
      return;
    }
    return this.json(res, 404, {});
  }

  private detail(r: MockRoom) {
    return { id: r.id, name: r.name, description: r.description, bridge_id: r.bridge_id, external_channel_id: r.external_channel_id, connected_user_names: [...r.users], agent_ids: [] };
  }
}
