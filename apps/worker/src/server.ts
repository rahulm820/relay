// apps/worker: queue consumers (one per stage), the outbox dispatcher and a health endpoint.
// The ticket stage is real (#8); other stage and outbox handlers are skeletons that later issues replace (see @relay/core).
import { createServer } from "node:http";
import { Orchestrator, OutboxDispatcher, Redis, createDefaultOutboxRegistry, createDefaultStageRegistry, githubSyncStage, priorityStage, ticketStage } from "@relay/core";
import { createPool, withTenant } from "@relay/db";
import { createExtractor, createLlmProvider } from "@relay/llm";
import { ConfigError, EnvSecretProvider, PIPELINE_VERSION, PROMPT_VERSION, loadConfig } from "@relay/shared";

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

// Extraction (#7). Without a provider key and fast model the placeholder runs instead: every message
// then becomes a quarantined triage ticket, so nothing is lost, but the worker says so at startup.
const llmReady = config.llm.provider === "ollama" || config.llm.apiKey !== undefined;
const fastModel = config.llm.fastModel;
const extract = llmReady && fastModel
  ? createExtractor({
      provider: createLlmProvider(config.llm),
      model: fastModel,
      promptVersion: PROMPT_VERSION,
      recordRun: (run) => withTenant(pool, run.tenantId, (c) =>
        c.query(
          `INSERT INTO llm_runs (tenant_id, model, prompt_version, input_hash, output_json, confidence, latency_ms, cost)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [run.tenantId, run.model, run.promptVersion, run.inputHash,
            run.outputJson === null ? null : JSON.stringify(run.outputJson),
            run.confidence, run.latencyMs, run.costUsd],
        )).then(() => undefined),
    })
  : undefined;
if (!extract) console.warn(JSON.stringify({ msg: "llm not configured; using placeholder extractor", provider: config.llm.provider }));

// Stages that are not implemented yet stay no-op skeletons (see createDefaultStageRegistry).
const stages = createDefaultStageRegistry(extract ? { extract } : {});
stages.register("priority", priorityStage());
stages.register("ticket", ticketStage());
// GitHub issue creation (#9). Tokens are read from env:NAME refs stored on the integration.
stages.register("github-sync", githubSyncStage({ secrets: new EnvSecretProvider(process.env) }));
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
