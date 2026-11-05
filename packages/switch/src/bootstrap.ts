import type { Secret } from "@relay/shared";
import type { SwitchClient } from "./client.js";

export interface BootstrapOptions {
  client: SwitchClient;
  triagerAgent: string;
  notifierAgent: string;
  /** Whether SWITCH_NOTIFIER_API_KEY is already set, so an existing notifier can be left alone. */
  haveNotifierKey: boolean;
  /** Issue a new notifier key even though the agent exists (the old key stops working). */
  rotateKey: boolean;
  /** Stores the notifier key somewhere private. It is never printed. */
  storeNotifierKey: (key: Secret) => Promise<void>;
  /** Progress lines: no keys, passwords or cookies. */
  out: (line: string) => void;
}

/**
 * One-time, repeatable setup: makes sure the triager and notifier agents exist and that a bridge is available.
 * Idempotent: with everything in place it changes nothing. Agents are registered through the gateway
 * (`register-other`), which returns an API key once; only the notifier's key is kept, because only it posts.
 */
export async function bootstrapSwitch(o: BootstrapOptions): Promise<void> {
  const bridges = await o.client.listBridges();
  const usable = bridges.find((b) => b.isDefault && b.status === "running");
  o.out(usable ? "bridge: default bridge is running (rooms will appear in the team chat)" : "bridge: WARNING no running default bridge; rooms would exist only inside Switch");

  const existing = new Set((await o.client.listAgents()).map((a) => a.name));

  if (existing.has(o.triagerAgent)) o.out(`agent ${o.triagerAgent}: already registered`);
  else {
    await o.client.registerAgent({ name: o.triagerAgent, description: "Relay triager: summarises and routes a ticket inside its room.", displayName: "Relay Triager" });
    o.out(`agent ${o.triagerAgent}: registered`);
  }

  if (existing.has(o.notifierAgent) && o.haveNotifierKey && !o.rotateKey) {
    o.out(`agent ${o.notifierAgent}: already registered, key already configured`);
    return;
  }
  if (existing.has(o.notifierAgent) && !o.rotateKey) {
    o.out(`agent ${o.notifierAgent}: exists but SWITCH_NOTIFIER_API_KEY is not set. Switch shows an API key only once; re-run with --rotate-keys to issue a new one.`);
    return;
  }
  const agent = await o.client.registerAgent({
    name: o.notifierAgent, description: "Relay notifier: posts the ticket and pings its owner.", displayName: "Relay Notifier", overwrite: existing.has(o.notifierAgent),
  });
  await o.storeNotifierKey(agent.apiKey);
  o.out(`agent ${o.notifierAgent}: ${existing.has(o.notifierAgent) ? "key rotated" : "registered"}; key stored (not shown)`);
}
