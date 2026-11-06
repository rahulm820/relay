import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { Secret } from "@relay/shared";
import { SwitchAuthError, SwitchClient, SwitchRequestError, SwitchUnavailableError } from "./index.js";
import { MockSwitch } from "./testing/mock-switch.js";

let mock: MockSwitch;
before(async () => { mock = new MockSwitch(); await mock.start(); });
after(async () => { await mock.stop(); });
afterEach(() => { mock.rooms.length = 0; mock.messages.length = 0; mock.requests.length = 0; mock.agents.clear(); mock.logins = 0; mock.loginStatus = null; mock.expireSessions(); });

const make = (extra: Partial<ConstructorParameters<typeof SwitchClient>[0]> = {}) =>
  new SwitchClient({ gatewayUrl: mock.gatewayUrl, email: mock.email, password: new Secret(mock.password), timeoutMs: 400, ...extra });
const leaks = (e: unknown, ...secrets: string[]) => {
  const text = `${(e as Error).message} ${(e as Error).stack} ${JSON.stringify(e)}`;
  for (const s of secrets) assert.ok(!text.includes(s), "error must not contain a secret");
};

describe("login and session", () => {
  it("logs in once and reuses the cookie", async () => {
    const c = make();
    await c.listBridges(); await c.listAgents(); await c.listBridges();
    assert.equal(mock.logins, 1);
    const cookies = new Set(mock.requests.filter((r) => r.cookie).map((r) => r.cookie));
    assert.equal(cookies.size, 1);
  });

  it("a 401 triggers exactly one re-login and the call succeeds", async () => {
    const c = make();
    await c.listBridges();
    mock.expireSessions();
    assert.equal((await c.listBridges()).length, 1);
    assert.equal(mock.logins, 2);
  });

  it("gives up with an auth error when the session keeps being rejected (one re-login only)", async () => {
    const c = make();
    mock.fault("GET /gateway/agents", { status: 401, times: 5 });
    await assert.rejects(c.listAgents(), SwitchAuthError);
    assert.equal(mock.logins, 2);
  });

  it("bad credentials -> SwitchAuthError without leaking the password", async () => {
    const c = make({ password: new Secret("wrong-password-value") });
    await assert.rejects(c.listBridges(), (e) => { leaks(e, "wrong-password-value", mock.email); return e instanceof SwitchAuthError && e.code === "switch_auth_failed"; });
  });

  it("disabled password login (403) is a distinct permanent auth error", async () => {
    mock.loginStatus = 403;
    await assert.rejects(make().listBridges(), (e) => e instanceof SwitchAuthError && e.code === "switch_password_login_disabled");
  });
});

describe("error classification", () => {
  it("timeouts, 5xx and 429 are transient; other 4xx are permanent", async () => {
    const c = make();
    await c.listBridges();
    mock.fault("GET /gateway/agents", { delayMs: 800 });
    await assert.rejects(c.listAgents(), (e) => e instanceof SwitchUnavailableError && e.code === "switch_timeout");
    mock.fault("GET /gateway/agents", { status: 503 });
    await assert.rejects(c.listAgents(), (e) => e instanceof SwitchUnavailableError && e.code === "switch_http_503");
    mock.fault("GET /gateway/agents", { status: 429 });
    await assert.rejects(c.listAgents(), SwitchUnavailableError);
    mock.fault("GET /gateway/agents", { status: 404 });
    await assert.rejects(c.listAgents(), (e) => e instanceof SwitchRequestError && e.status === 404 && e.code === "switch_http_404");
  });

  it("an unreachable server is transient", async () => {
    const c = make({ gatewayUrl: "http://127.0.0.1:1/gateway" });
    await assert.rejects(c.listBridges(), (e) => e instanceof SwitchUnavailableError && e.code === "switch_unreachable");
  });
});

describe("rooms", () => {
  it("createRoom sends exactly the fields Switch's CreateRoom schema defines", async () => {
    const c = make();
    await c.registerAgent({ name: "a1", description: "d", displayName: "A1" });
    await c.createRoom({ name: "relay-1234abcd", description: "desc", instructions: "ins", agentNames: ["a1"] });
    const body = mock.requests.find((r) => r.method === "POST" && r.path === "/gateway/rooms")!.body;
    assert.deepEqual(Object.keys(body).sort(), ["agent_names", "channel_type", "description", "instructions", "name", "read_visibility", "write_visibility"]);
    assert.deepEqual([body.channel_type, body.read_visibility, body.write_visibility, body.agent_names], ["channel_public", "public", "public", ["a1"]]);
    await c.createRoom({ name: "r2", description: "d", instructions: "i", agentNames: ["a1"], bridgeId: "bridge-9" });
    assert.equal(mock.requests.filter((r) => r.path === "/gateway/rooms" && r.method === "POST").at(-1)!.body.bridge_id, "bridge-9");
  });

  it("findRoom matches only a description containing the marker and ignores archived rooms", async () => {
    const c = make();
    await c.registerAgent({ name: "a1", description: "d", displayName: "A1" });
    const a = await c.createRoom({ name: "relay-aaaa0000", description: "x relay:ticket:A", instructions: "i", agentNames: ["a1"] });
    await c.createRoom({ name: "relay-aaaa0000", description: "x relay:ticket:B", instructions: "i", agentNames: ["a1"] });
    assert.equal((await c.findRoom("relay-aaaa0000", "relay:ticket:A"))?.id, a.id);
    assert.equal(await c.findRoom("relay-aaaa0000", "relay:ticket:C"), null);
    await c.archiveRoom(a.id);
    assert.equal(await c.findRoom("relay-aaaa0000", "relay:ticket:A"), null);
  });

  it("addUsers reports who ended up in the room", async () => {
    const c = make();
    mock.knownUsers.add("known");
    await c.registerAgent({ name: "a1", description: "d", displayName: "A1" });
    const room = await c.createRoom({ name: "r", description: "d", instructions: "i", agentNames: ["a1"] });
    assert.deepEqual(await c.addUsers(room.id, ["known", "ghost"]), { added: ["known"], missing: ["ghost"] });
    assert.deepEqual(await c.addUsers(room.id, []), { added: [], missing: [] });
  });
});

describe("agents and posting", () => {
  it("registerAgent returns the key once, wrapped so it cannot be printed; 409 without overwrite", async () => {
    const c = make();
    const a = await c.registerAgent({ name: "n1", description: "d", displayName: "N" });
    assert.equal(String(a.apiKey), "[REDACTED]");
    assert.equal(JSON.stringify(a), JSON.stringify({ id: a.id, apiKey: "[REDACTED]" }));
    await assert.rejects(c.registerAgent({ name: "n1", description: "d", displayName: "N" }), (e) => e instanceof SwitchRequestError && e.status === 409);
    const again = await c.registerAgent({ name: "n1", description: "d", displayName: "N", overwrite: true });
    assert.notEqual(again.apiKey.reveal(), a.apiKey.reveal());
  });

  it("postToRoom posts as the notifier agent with its bearer key to the agent API", async () => {
    const setup = make();
    const n = await setup.registerAgent({ name: "notifier", description: "d", displayName: "N" });
    const room = await setup.createRoom({ name: "r", description: "d", instructions: "i", agentNames: ["notifier"] });
    const c = make({ notifier: { name: "notifier", apiKey: n.apiKey } });
    await c.postToRoom(room.id, "hello team");
    assert.deepEqual(mock.messages, [{ roomId: room.id, content: "hello team", agentId: n.id }]);
    const req = mock.requests.find((r) => r.path === `/agents/${n.id}/message`)!;
    assert.deepEqual(req.body, { room_id: room.id, content: "hello team" });
    assert.equal(req.auth, `Bearer ${n.apiKey.reveal()}`);
  });

  it("a rejected agent key is an auth error, an unknown room a permanent request error, no leaks", async () => {
    const setup = make();
    const n = await setup.registerAgent({ name: "notifier", description: "d", displayName: "N" });
    const room = await setup.createRoom({ name: "r", description: "d", instructions: "i", agentNames: ["notifier"] });
    await assert.rejects(make({ notifier: { name: "notifier", apiKey: new Secret("wrong-key-value") } }).postToRoom(room.id, "x"),
      (e) => { leaks(e, "wrong-key-value"); return e instanceof SwitchAuthError && e.code === "switch_agent_key_rejected"; });
    await assert.rejects(make({ notifier: { name: "notifier", apiKey: n.apiKey } }).postToRoom("no-such-room", "x"),
      (e) => e instanceof SwitchRequestError && e.status === 404);
    await assert.rejects(make().postToRoom(room.id, "x"), SwitchRequestError);
  });

  it("missingAgents names only what is not registered", async () => {
    const c = make();
    await c.registerAgent({ name: "have", description: "d", displayName: "H" });
    assert.deepEqual(await c.missingAgents(["have", "lack"]), ["lack"]);
  });
});
