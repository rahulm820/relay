// apps/api: HTTP API (auth, tickets, configuration) and the Telegram webhook.
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { ChannelRegistry, TelegramAdapter, baselineRedact, type Redactor } from "@relay/channels";
import { QueueProducer, Redis } from "@relay/core";
import { createPool, type Pool } from "@relay/db";
import { ConfigError, PIPELINE_VERSION, loadConfig, parseEncryptionKey } from "@relay/shared";
import Fastify, { type FastifyError } from "fastify";
import { registerAdminRoutes } from "./admin-routes.js";
import type { Authenticator } from "./auth.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { pgAuthStore } from "./pg-auth-store.js";
import { registerApiSecurity } from "./security.js";
import { LoginThrottle, sessionAuthenticator, type AuthStore } from "./session.js";
import { registerTelegramWebhook } from "./telegram-webhook.js";
import { registerTicketRoutes } from "./tickets.js";

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
  /** Admin API settings (see ADMIN_* in .env.example). */
  admin?: { allowedOrigins: string[]; sessionTtlHours: number; sessionIdleMinutes: number; cookieSecure: boolean };
  /** Session and user storage. Defaults to Postgres; tests can supply one in memory. */
  authStore?: AuthStore;
  /** Replaces the cookie-session authenticator (tests only). */
  authenticate?: Authenticator;
  throttle?: LoginThrottle;
}

const DEFAULT_ADMIN = { allowedOrigins: ["http://localhost:3000"], sessionTtlHours: 12, sessionIdleMinutes: 60, cookieSecure: false };

export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    // Headers carrying credentials are masked even though the default request serializer omits them.
    logger: {
      level: deps.logLevel ?? "info",
      redact: ["req.headers.authorization", 'req.headers["x-telegram-bot-api-secret-token"]'],
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    genReqId: () => randomUUID(),
    bodyLimit: 128 * 1024,
  });
  const admin = deps.admin ?? DEFAULT_ADMIN;

  // A JSON request with an empty body (a logout or delete sent with a JSON content type) means "no body", not an
  // error; genuinely malformed JSON is still a generic 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("invalid json"), { statusCode: 400 }), undefined);
    }
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

  // /api: browser protections first (CORS, CSRF), then sign-in, then the routes that need a session.
  const store = deps.authStore ?? pgAuthStore(deps.pool);
  const authenticate = deps.authenticate ?? sessionAuthenticator(store, admin.sessionIdleMinutes * 60);
  registerApiSecurity(app, { allowedOrigins: admin.allowedOrigins });
  registerAuthRoutes(app, {
    store, authenticate, throttle: deps.throttle ?? new LoginThrottle(), sessionTtlHours: admin.sessionTtlHours, cookieSecure: admin.cookieSecure,
  });
  registerTicketRoutes(app, { pool: deps.pool, authenticate });
  registerAdminRoutes(app, { pool: deps.pool, authenticate });
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
    admin: config.admin,
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
