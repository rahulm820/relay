// apps/worker: queue consumers (one per stage), the outbox dispatcher and a health endpoint.
// The ticket stage is real (#8); other stage and outbox handlers are skeletons that later issues replace (see @relay/core).
import { createServer } from "node:http";
import { Orchestrator, OutboxDispatcher, Redis, createDefaultOutboxRegistry, createDefaultStageRegistry, ticketStage } from "@relay/core";
import { createPool } from "@relay/db";
import { ConfigError, PIPELINE_VERSION, loadConfig } from "@relay/shared";

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
const orchestrator = new Orchestrator({ pool, redis, stages });
const dispatcher = new OutboxDispatcher({ pool, registry: createDefaultOutboxRegistry() });

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
