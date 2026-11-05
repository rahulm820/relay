import { Secret } from "@relay/shared";
import { SwitchAuthError, SwitchRequestError, SwitchUnavailableError } from "./errors.js";

export interface SwitchClientOptions {
  /** e.g. http://localhost:8000/gateway (cookie-authenticated management API). */
  gatewayUrl: string;
  /** Agent API, e.g. http://localhost:8000. Defaults to gatewayUrl without a trailing /gateway. */
  apiUrl?: string;
  email: string;
  password: Secret;
  /** The agent that posts into rooms. Needed only for postToRoom. */
  notifier?: { name: string; apiKey: Secret };
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface SwitchBridge {
  id: string;
  type: string;
  displayName: string;
  status: string;
  isDefault: boolean;
}

export interface SwitchRoom {
  id: string;
  name: string;
  description: string;
  bridgeId: string | null;
  externalChannelId: string | null;
  connectedUserNames: string[];
}

export interface CreateRoomInput {
  name: string;
  description: string;
  instructions: string;
  agentNames: string[];
  /** Omit to use Switch's default bridge (the bundled Mattermost on a standalone install). */
  bridgeId?: string;
}

export interface RegisteredAgent {
  id: string;
  apiKey: Secret;
}

interface Reply {
  status: number;
  body: any;
  setCookies: string[];
}

const trim = (url: string) => url.replace(/\/+$/, "");

/**
 * A small client for the parts of Switch that Relay uses. Contracts are taken from the Switch source:
 *   gateway (cookie `switch_auth`): auth/login, collaborations, agents, rooms
 *   agent API (Bearer agent key):   agents/{id}/message
 * The session cookie lives in memory only. A 401 triggers exactly one re-login and retry.
 * Errors: SwitchAuthError (bad credentials), SwitchUnavailableError (network, timeout, 5xx, 429: retry),
 * SwitchRequestError (other 4xx: do not retry). No error or log line ever contains a URL, cookie, key or body.
 */
export class SwitchClient {
  private readonly gateway: string;
  private readonly api: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private cookie: string | undefined;
  private loggingIn: Promise<void> | undefined;
  private readonly agentIds = new Map<string, string>();

  constructor(private readonly o: SwitchClientOptions) {
    this.gateway = trim(o.gatewayUrl);
    this.api = trim(o.apiUrl ?? o.gatewayUrl.replace(/\/gateway\/?$/, ""));
    this.fetchFn = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  // ---- transport ----------------------------------------------------------------------------------

  private async send(url: string, init: RequestInit): Promise<Reply> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const name = (err as Error).name;
      throw new SwitchUnavailableError(name === "TimeoutError" || name === "AbortError" ? "switch_timeout" : "switch_unreachable");
    }
    let body: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    return { status: res.status, body, setCookies: res.headers.getSetCookie() };
  }

  /** Maps non-2xx answers to typed errors. 401 is handled by the caller. */
  private fail(status: number): never {
    if (status >= 500 || status === 429 || status === 408) throw new SwitchUnavailableError(`switch_http_${status}`);
    throw new SwitchRequestError(status);
  }

  async login(): Promise<void> {
    this.loggingIn ??= this.doLogin().finally(() => { this.loggingIn = undefined; });
    return this.loggingIn;
  }

  private async doLogin(): Promise<void> {
    const r = await this.send(`${this.gateway}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.o.email, password: this.o.password.reveal() }),
    });
    if (r.status === 401 || r.status === 403) throw new SwitchAuthError(r.status === 403 ? "switch_password_login_disabled" : "switch_auth_failed");
    if (r.status < 200 || r.status >= 300) this.fail(r.status);
    const raw = r.setCookies.find((c) => c.startsWith("switch_auth="));
    if (!raw) throw new SwitchAuthError("switch_no_session_cookie");
    this.cookie = raw.split(";")[0]!;
  }

  private async gw(method: string, path: string, body?: unknown): Promise<Reply> {
    const once = async () => {
      if (!this.cookie) await this.login();
      return this.send(`${this.gateway}${path}`, {
        method,
        headers: { cookie: this.cookie!, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    };
    let r = await once();
    if (r.status === 401) {
      this.cookie = undefined; // session expired or revoked: log in again once
      r = await once();
      if (r.status === 401) throw new SwitchAuthError();
    }
    if (r.status < 200 || r.status >= 300) this.fail(r.status);
    return r;
  }

  // ---- gateway: bridges, agents, rooms --------------------------------------------------------------

  async listBridges(): Promise<SwitchBridge[]> {
    const { body } = await this.gw("GET", "/collaborations");
    return (Array.isArray(body) ? body : []).map((b: any) => ({
      id: b.bridge_id, type: b.bridge_type, displayName: b.display_name, status: b.status, isDefault: Boolean(b.is_default),
    }));
  }

  async listAgents(): Promise<{ id: string; name: string }[]> {
    const { body } = await this.gw("GET", "/agents");
    return (Array.isArray(body) ? body : []).map((a: any) => ({ id: a.id, name: a.name }));
  }

  /** Registers an agent Relay does not run itself. The API key is returned ONCE; the caller must store it safely. */
  async registerAgent(input: { name: string; description: string; displayName: string; overwrite?: boolean }): Promise<RegisteredAgent> {
    const { body } = await this.gw("POST", "/agents/register-other", {
      name: input.name, description: input.description, display_name: input.displayName, overwrite: input.overwrite ?? false,
    });
    this.agentIds.set(input.name, body.id);
    return { id: body.id, apiKey: new Secret(body.api_key) };
  }

  /** The Switch id of an agent, looked up by name and cached; undefined if it is not registered. */
  private async agentId(name: string): Promise<string | undefined> {
    if (!this.agentIds.has(name)) for (const a of await this.listAgents()) this.agentIds.set(a.name, a.id);
    return this.agentIds.get(name);
  }

  /** Which of these agent names are not registered in Switch. */
  async missingAgents(names: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const n of names) if (!(await this.agentId(n))) missing.push(n);
    return missing;
  }

  /** A live room whose description contains `marker` (Switch room names are not unique), or null. */
  async findRoom(searchName: string, marker: string): Promise<SwitchRoom | null> {
    const { body } = await this.gw("GET", `/rooms?search=${encodeURIComponent(searchName)}`);
    const hit = (Array.isArray(body) ? body : []).find((r: any) => typeof r.description === "string" && r.description.includes(marker));
    return hit ? toRoom(hit) : null;
  }

  /** POST /gateway/rooms. With no bridgeId Switch uses its default bridge and creates the channel itself. */
  async createRoom(input: CreateRoomInput): Promise<SwitchRoom> {
    const { body } = await this.gw("POST", "/rooms", {
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      agent_names: input.agentNames,
      channel_type: "channel_public",
      read_visibility: "public",
      write_visibility: "public",
      ...(input.bridgeId ? { bridge_id: input.bridgeId } : {}),
    });
    return toRoom(body);
  }

  /**
   * Adds people to a bridged room by their username on the messaging app. Switch silently skips names the
   * bridge does not know, so the result says who is actually in the room afterwards.
   */
  async addUsers(roomRef: string, userNames: string[]): Promise<{ added: string[]; missing: string[] }> {
    if (userNames.length === 0) return { added: [], missing: [] };
    const { body } = await this.gw("POST", `/rooms/${encodeURIComponent(roomRef)}/users`, { user_names: userNames });
    const present = new Set<string>(body?.connected_user_names ?? []);
    return { added: userNames.filter((n) => present.has(n)), missing: userNames.filter((n) => !present.has(n)) };
  }

  async archiveRoom(roomRef: string): Promise<void> {
    await this.gw("POST", `/rooms/${encodeURIComponent(roomRef)}/archive`);
  }

  // ---- agent API: posting ---------------------------------------------------------------------------

  /**
   * Posts `text` into a Switch room as the notifier agent (POST /agents/{id}/message). `roomRef` is the Switch
   * room id, the value stored in tickets.switch_room_ref. Plain text; Switch bridges it to the team chat.
   * Not idempotent on Switch's side: callers that must not repeat a post keep their own record.
   */
  async postToRoom(roomRef: string, text: string): Promise<void> {
    const notifier = this.o.notifier;
    if (!notifier) throw new SwitchRequestError(401);
    const agentId = await this.agentId(notifier.name);
    if (!agentId) throw new SwitchRequestError(404);
    const r = await this.send(`${this.api}/agents/${encodeURIComponent(agentId)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${notifier.apiKey.reveal()}` },
      body: JSON.stringify({ room_id: roomRef, content: text }),
    });
    if (r.status === 401) throw new SwitchAuthError("switch_agent_key_rejected");
    if (r.status < 200 || r.status >= 300) this.fail(r.status);
  }
}

function toRoom(r: any): SwitchRoom {
  return {
    id: r.id, name: r.name, description: r.description ?? "", bridgeId: r.bridge_id ?? null,
    externalChannelId: r.external_channel_id ?? null, connectedUserNames: r.connected_user_names ?? [],
  };
}
