// apps/api: HTTP API and webhooks. Admin routes arrive in Issue #17.
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { ChannelRegistry, TelegramAdapter, baselineRedact, type Redactor } from "@relay/channels";
import { QueueProducer, Redis } from "@relay/core";
import { createPool, type Pool } from "@relay/db";
import { ConfigError, PIPELINE_VERSION, loadConfig, parseEncryptionKey } from "@relay/shared";
import Fastify, { type FastifyError } from "fastify";
import { registerTelegramWebhook } from "./telegram-webhook.js";

export interface ServerDeps {
  pool: Pool;
  producer: Pick<QueueProducer, "enqueue">;
  encryptionKey: Buffer;
  /** Replace with the real redactor from Issue #7 when it lands. */
  redact?: Redactor;
  /** Telegram Bot API base URL (tests point it at a local mock). */
  telegramApiBaseUrl?: string;
  /** Where log lines go (tests capture them). Defaults to stdout. */
  logStream?: Writable;
  logLevel?: string;
}

export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    // Headers carrying credentials are masked even though the default request serializer omits them.
    logger: {
      level: deps.logLevel ?? "info",
      redact: ["req.headers.authorization", 'req.headers["x-telegram-bot-api-secret-token"]'],
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    genReqId: () => randomUUID(),
  });

  // Never echo parser or database error text to the caller, and never log it: it could quote the body.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: "bad_request" });
    req.log.error({ event: "request_failed", errorCode: String(err.code ?? err.name) }, "request failed");
    return reply.code(503).send({ error: "unavailable" });
  });

  app.get("/healthz", async () => ({ status: "ok", service: "api", pipelineVersion: PIPELINE_VERSION }));

  const registry = new ChannelRegistry().register(
    "telegram",
    (bot) => new TelegramAdapter({ ...bot, ...(deps.telegramApiBaseUrl ? { apiBaseUrl: deps.telegramApiBaseUrl } : {}) }),
  );
  registerTelegramWebhook(app, {
    pool: deps.pool,
    producer: deps.producer as QueueProducer,
    registry,
    redact: deps.redact ?? baselineRedact,
    encryptionKey: deps.encryptionKey,
  });
  return app;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : "failed to load configuration");
    process.exit(1);
  }
  const rawKey = config.security.messageEncryptionKey;
  if (!rawKey) {
    console.error("Invalid configuration: MESSAGE_ENCRYPTION_KEY is required for the API");
    process.exit(1);
  }

  // DATABASE_URL must be the relay_api login (RLS applies); never the schema owner.
  const pool = createPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl);
  redis.on("error", (err) => console.error(JSON.stringify({ msg: "redis error", code: err.name })));
  const app = buildServer({
    pool, producer: new QueueProducer(redis), encryptionKey: parseEncryptionKey(rawKey.reveal()), logLevel: config.logLevel,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    await app.close(); // stops accepting and waits for in-flight requests
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.api.port, host: config.api.host });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ msg: "api failed to start", code: (err as { code?: string }).code ?? "unknown" }));
    process.exit(1);
  });
}
