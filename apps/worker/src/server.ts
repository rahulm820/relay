// apps/worker: queue consumers (one per stage), the outbox dispatcher and a health endpoint.
// The ticket and notify stages (#8, #16) and the switch.create_room and client.send outbox handlers (#15, #16) are real; the rest are skeletons that
// later issues replace (see @relay/core).
import { createServer } from "node:http";
import { createClientSendHandler, createPgClientSendStore } from "@relay/channels";
import { Orchestrator, OutboxDispatcher, Redis, createDefaultOutboxRegistry, createDefaultStageRegistry, notifyStage, ticketStage } from "@relay/core";
import { createPool } from "@relay/db";
import { createSwitchRoomHandler, switchFromConfig } from "@relay/switch";
import { ConfigError, EnvSecretProvider, PIPELINE_VERSION, loadConfig } from "@relay/shared";

let config;
try {
  config = loadConfig();
} catch (err) {
  // ConfigError names the offending variables and never their values.
  console.error(err instanceof ConfigError ? err.message : "failed to load configuration");
  process.exit(1);
}

// DATABASE_URL must be the relay_worker login (RLS applies); never the schema owner.
const pool = createPool(config.databaseUrl);
const redis = new Redis(config.redisUrl);
redis.on("error", (err) => console.error(JSON.stringify({ msg: "redis error", code: err.name })));

// Stages that are not implemented yet stay no-op skeletons (see createDefaultStageRegistry).
const stages = createDefaultStageRegistry();
stages.register("ticket", ticketStage());
stages.register("notify", notifyStage()); // queues the acknowledgement / refusal / clarification (#16)
const orchestrator = new Orchestrator({ pool, redis, stages });
// Switch rooms are created by the outbox (switch.create_room), not by the pipeline's `switch` stage, which stays a
// skeleton: the outbox row is the retry mechanism and is written in the same transaction as the ticket.
// Without Switch settings the worker still boots; those rows then fail with code switch_not_configured.
const { client: switchClient, missing: switchMissing } = switchFromConfig(config.switch);
if (!switchClient) console.warn(JSON.stringify({ msg: "switch integration disabled", missing: switchMissing }));
const outboxHandlers = createDefaultOutboxRegistry();
outboxHandlers.register("switch.create_room", createSwitchRoomHandler({
  pool, client: switchClient, missing: switchMissing,
  triagerAgent: config.switch.triagerAgent, notifierAgent: config.switch.notifierAgent,
  ...(config.switch.bridgeId ? { bridgeId: config.switch.bridgeId } : {}),
}));
// client.send (#16): bot tokens come from the environment variable each bot's credentials_ref names. A missing token
// fails that row with code bot_token_missing; the worker itself still boots.
outboxHandlers.register("client.send", createClientSendHandler({
  store: createPgClientSendStore(pool), tokens: new EnvSecretProvider(process.env),
  ...(config.telegram.apiBaseUrl ? { apiBaseUrl: config.telegram.apiBaseUrl } : {}),
}));
const dispatcher = new OutboxDispatcher({ pool, registry: outboxHandlers });

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "worker", pipelineVersion: PIPELINE_VERSION }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

await orchestrator.start();
dispatcher.start();
server.listen(config.worker.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "worker listening", port: config.worker.port }));
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ msg: "shutting down", signal }));
  server.close();
  // Stop taking new work, let in-flight stages and outbox handlers finish, then release connections.
  await Promise.all([orchestrator.close(), dispatcher.close()]);
  await redis.quit();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
