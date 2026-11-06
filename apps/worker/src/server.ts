// apps/worker: queue consumers (one per stage), the outbox dispatcher, the GitHub reconcile job and health endpoints.
// The ticket and notify stages (#8, #16) and the switch.create_room and client.send outbox handlers (#15, #16) are real; the rest are skeletons that
// later issues replace (see @relay/core).
import { createServer } from "node:http";
import { createClientSendHandler, createPgClientSendStore } from "@relay/channels";
import {
  Orchestrator, OutboxDispatcher, PeriodicJob, Redis, SyncMetrics, createDefaultOutboxRegistry, createDefaultStageRegistry, dedupeStage, priorityStage,
  createGithubCreateIssueHandler, createPgReconcileStore, getSyncHealth, githubSyncStage, notifyStage, reconcileOnce,
  reconcileSettingsFromEnv, ticketStage,
} from "@relay/core";
import { createPool, withTenant } from "@relay/db";
import { createEmbedder, createExtractor, createLlmProvider } from "@relay/llm";
import { createSwitchRoomHandler, switchFromConfig } from "@relay/switch";
import { ConfigError, EnvSecretProvider, PIPELINE_VERSION, PROMPT_VERSION, loadConfig } from "@relay/shared";

let config;
let reconcileSettings;
try {
  config = loadConfig();
  reconcileSettings = reconcileSettingsFromEnv();
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
// Duplicate detection (#11). Without an embedding model configured it matches nothing and every complaint is its own ticket.
const embedder = createEmbedder(config.llm);
if (!embedder) console.warn(JSON.stringify({ msg: "no embedding model; duplicate detection disabled", provider: config.llm.provider }));
stages.register("dedupe", dedupeStage({
  embed: embedder ? (text, signal) => embedder.embed(text, signal) : undefined,
  similarity: config.dedupe.similarity,
  windowHours: config.dedupe.windowHours,
}));
stages.register("priority", priorityStage());
stages.register("ticket", ticketStage());
stages.register("notify", notifyStage()); // queues the acknowledgement / refusal / clarification (#16)
// GitHub issue creation (#12): the stage only reports sync state; the outbox handler below does the work.
// Tokens are read from env:NAME refs stored on the integration.
const secrets = new EnvSecretProvider(process.env);
stages.register("github-sync", githubSyncStage());
const orchestrator = new Orchestrator({ pool, redis, stages });
// Switch rooms are created by the outbox (switch.create_room), not by the pipeline's `switch` stage, which stays a
// skeleton: the outbox row is the retry mechanism and is written in the same transaction as the ticket.
// Without Switch settings the worker still boots; those rows then fail with code switch_not_configured.
const { client: switchClient, missing: switchMissing } = switchFromConfig(config.switch);
if (!switchClient) console.warn(JSON.stringify({ msg: "switch integration disabled", missing: switchMissing }));
const outboxHandlers = createDefaultOutboxRegistry();
// github.create_issue (#12): creates exactly one GitHub issue per ticket, with retries and a pre-create lookup.
outboxHandlers.register("github.create_issue", createGithubCreateIssueHandler({ pool, secrets }));
outboxHandlers.register("switch.create_room", createSwitchRoomHandler({
  pool, client: switchClient, missing: switchMissing,
  triagerAgent: config.switch.triagerAgent, notifierAgent: config.switch.notifierAgent,
  ...(config.switch.bridgeId ? { bridgeId: config.switch.bridgeId } : {}),
}));
// client.send (#16): bot tokens come from the environment variable each bot's credentials_ref names. A missing token
// fails that row with code bot_token_missing; the worker itself still boots.
outboxHandlers.register("client.send", createClientSendHandler({
  store: createPgClientSendStore(pool), tokens: secrets,
  ...(config.telegram.apiBaseUrl ? { apiBaseUrl: config.telegram.apiBaseUrl } : {}),
}));
const dispatcher = new OutboxDispatcher({ pool, registry: outboxHandlers });

// GitHub reconcile (#20): repairs tracker_issues drift on a schedule. RECONCILE_INTERVAL_SECONDS=0 turns it off.
const syncMetrics = new SyncMetrics();
const reconcileStore = createPgReconcileStore({
  pool, graceSeconds: reconcileSettings.graceSeconds, staleSeconds: reconcileSettings.staleSeconds, retryBudget: reconcileSettings.retryBudget,
});
const reconcileJob = reconcileSettings.intervalSeconds > 0
  ? new PeriodicJob(async () => {
      const summary = await reconcileOnce({ store: reconcileStore, secrets });
      syncMetrics.record(summary);
      // Counts only; a quiet pass logs nothing.
      if (summary.examined > 0) console.log(JSON.stringify({ event: "reconcile_pass", ...summary }));
    }, reconcileSettings.intervalSeconds * 1000, (err) => {
      syncMetrics.recordFailure();
      console.error(JSON.stringify({ event: "reconcile_pass_error", errorCode: err instanceof Error ? err.name : "unknown" }));
    })
  : undefined;

const server = createServer((req, res) => {
  // GitHub sync health (#20): outbox backlog age, failures, tracker row counts and alert flags. Counts only.
  if (req.method === "GET" && req.url === "/healthz/sync") {
    getSyncHealth(pool, reconcileSettings.retryBudget, { backlogSeconds: reconcileSettings.backlogAlertSeconds }, syncMetrics)
      .then((health) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(health)); })
      .catch(() => { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unavailable" })); });
    return;
  }
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
reconcileJob?.start();
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
  await Promise.all([orchestrator.close(), dispatcher.close(), reconcileJob?.close()]);
  await redis.quit();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
