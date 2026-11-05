import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Secret } from "@relay/shared";
import { SwitchClient } from "./index.js";
import { bootstrapSwitch } from "./bootstrap.js";
import { MockSwitch } from "./testing/mock-switch.js";

let mock: MockSwitch;
before(async () => { mock = new MockSwitch(); await mock.start(); });
after(async () => { await mock.stop(); });
beforeEach(() => { mock.agents.clear(); mock.requests.length = 0; });

async function run(opts: { haveNotifierKey?: boolean; rotateKey?: boolean } = {}) {
  const out: string[] = [];
  const stored: string[] = [];
  mock.requests.length = 0; // count only this run's calls
  await bootstrapSwitch({
    client: new SwitchClient({ gatewayUrl: mock.gatewayUrl, email: mock.email, password: new Secret(mock.password) }),
    triagerAgent: "relay-triager", notifierAgent: "relay-notifier",
    haveNotifierKey: opts.haveNotifierKey ?? false, rotateKey: opts.rotateKey ?? false,
    storeNotifierKey: async (k) => { stored.push(k.reveal()); }, out: (l) => out.push(l),
  });
  return { out, stored, registrations: mock.requests.filter((r) => r.path === "/gateway/agents/register-other") };
}

describe("bootstrapSwitch", () => {
  it("registers both agents and stores only the notifier key, never printing it", async () => {
    const r = await run();
    assert.deepEqual([...mock.agents.keys()].sort(), ["relay-notifier", "relay-triager"]);
    assert.equal(r.stored.length, 1);
    assert.equal(r.stored[0], mock.agents.get("relay-notifier")!.key);
    assert.ok(!r.out.join("\n").includes(r.stored[0]!));
    assert.ok(r.out.some((l) => l.includes("bridge: default bridge is running")));
  });

  it("is idempotent: with the key configured a second run changes nothing", async () => {
    await run();
    const second = await run({ haveNotifierKey: true });
    assert.equal(second.registrations.length, 0);
    assert.equal(second.stored.length, 0);
  });

  it("an existing notifier without a known key is reported, not silently replaced", async () => {
    await run();
    const before = mock.agents.get("relay-notifier")!.key;
    const second = await run({ haveNotifierKey: false });
    assert.equal(second.registrations.length, 0);
    assert.equal(mock.agents.get("relay-notifier")!.key, before);
    assert.ok(second.out.some((l) => l.includes("--rotate-keys")));
  });

  it("--rotate-keys issues a new notifier key and stores it", async () => {
    await run();
    const before = mock.agents.get("relay-notifier")!.key;
    const rotated = await run({ rotateKey: true });
    assert.notEqual(mock.agents.get("relay-notifier")!.key, before);
    assert.deepEqual(rotated.stored, [mock.agents.get("relay-notifier")!.key]);
    assert.equal(mock.agents.size, 2);
  });
});
