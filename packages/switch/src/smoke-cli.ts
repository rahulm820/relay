// LIVE SMOKE TEST against a running Switch. Usage: npm run switch:smoke -w @relay/switch
// Needs SWITCH_GATEWAY_URL, SWITCH_ADMIN_EMAIL, SWITCH_ADMIN_PASSWORD, SWITCH_NOTIFIER_API_KEY and the agents from
// `npm run switch:bootstrap`. Creates ONE room named relay-smoke-<time>, posts one message, then archives it.
// Prints step results only: no URLs, credentials, cookies or keys.
import { loadSwitchEnv } from "./env.js";

const env = loadSwitchEnv(process.env);
if (!env.ok) {
  console.error(`missing: ${env.missing.join(", ")}`);
  process.exit(1);
}
if (!process.env["SWITCH_NOTIFIER_API_KEY"]) {
  console.error("missing: SWITCH_NOTIFIER_API_KEY");
  process.exit(1);
}
const { client, triagerAgent, notifierAgent } = env;
let step = "login";
try {
  const bridges = await client.listBridges();
  console.log(`1 login ok; bridges: ${bridges.length} (default running: ${bridges.some((b) => b.isDefault && b.status === "running")})`);
  step = "agents";
  const missing = await client.missingAgents([triagerAgent, notifierAgent]);
  if (missing.length) throw Object.assign(new Error("agents missing"), { code: "switch_agents_missing" });
  console.log("2 agents present");
  step = "create room";
  const name = `relay-smoke-${Date.now()}`;
  const room = await client.createRoom({ name, description: "Relay smoke test. relay:smoke", instructions: "Smoke test room; safe to ignore.", agentNames: [triagerAgent, notifierAgent] });
  console.log(`3 room created (bridge channel: ${room.externalChannelId ? "yes" : "no"})`);
  step = "post";
  await client.postToRoom(room.id, "Relay smoke test: if you can read this in the team chat, the Switch integration works.");
  console.log("4 message posted by the notifier agent");
  step = "archive";
  await client.archiveRoom(room.id);
  console.log("5 room archived. SMOKE OK");
} catch (err) {
  console.error(`SMOKE FAILED at step "${step}": ${(err as { code?: string }).code ?? "error"}`);
  process.exitCode = 1;
}
