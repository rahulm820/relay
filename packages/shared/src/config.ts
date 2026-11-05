import { z } from "zod";
import { Secret } from "./secret.js";

// Environment is validated once at startup. Errors name the offending variables only,
// never their values. Empty strings (`FOO=` in .env) count as unset.

const empty = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(empty, z.string().optional());
const optionalUrl = z.preprocess(empty, z.url().optional());
const port = z.preprocess(empty, z.coerce.number().int().min(1).max(65535));
const secret = z.preprocess(empty, z.string().min(1).optional()).transform((v) => (v === undefined ? undefined : new Secret(v)));

export const LLM_PROVIDERS = ["gemini", "anthropic", "ollama"] as const;

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: port.default(8080),
  WORKER_PORT: port.default(8081),

  TELEGRAM_WEBHOOK_PUBLIC_URL: optionalUrl,

  /** Base64 of 32 random bytes (`openssl rand -base64 32`). Encrypts raw message text at rest. */
  MESSAGE_ENCRYPTION_KEY: z.preprocess(
    empty,
    z.string().refine((v) => Buffer.from(v, "base64").length === 32, { message: "must be 32 bytes, base64" }).optional(),
  ).transform((v) => (v === undefined ? undefined : new Secret(v))),

  /** Browser origins allowed to call the admin API with credentials (comma separated). No wildcard. */
  ADMIN_ALLOWED_ORIGINS: z.preprocess(empty, z.string().default("http://localhost:3000")).transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),
  /** Absolute lifetime of an admin session, in hours. */
  ADMIN_SESSION_TTL_HOURS: z.preprocess(empty, z.coerce.number().int().min(1).max(168).default(12)),
  /** A session unused for this many minutes expires. */
  ADMIN_SESSION_IDLE_MINUTES: z.preprocess(empty, z.coerce.number().int().min(1).max(1440).default(60)),
  /** Send the session cookie only over HTTPS. Defaults to on in production. */
  ADMIN_COOKIE_SECURE: z.preprocess(empty, z.enum(["true", "false"]).optional()).transform((v) => (v === undefined ? undefined : v === "true")),

  GITHUB_TOKEN: secret,

  SWITCH_GATEWAY_URL: z.preprocess(empty, z.url().default("http://localhost:8000/gateway")),
  SWITCH_ADMIN_EMAIL: optionalString,
  SWITCH_ADMIN_PASSWORD: secret,
  AGENT_REGISTRATION_TOKEN: secret,
  SWITCH_BRIDGE_ID: optionalString,

  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default("gemini"),
  LLM_API_KEY: secret,
  LLM_BASE_URL: optionalUrl,
  LLM_FAST_MODEL: optionalString,
  LLM_STRONG_MODEL: optionalString,
});

export interface Config {
  nodeEnv: "development" | "test" | "production";
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  databaseUrl: string;
  redisUrl: string;
  api: { host: string; port: number };
  worker: { port: number };
  telegram: { webhookPublicUrl?: string };
  security: { messageEncryptionKey?: Secret };
  admin: { allowedOrigins: string[]; sessionTtlHours: number; sessionIdleMinutes: number; cookieSecure: boolean };
  github: { token?: Secret };
  switch: {
    gatewayUrl: string;
    adminEmail?: string;
    adminPassword?: Secret;
    agentRegistrationToken?: Secret;
    bridgeId?: string;
  };
  llm: {
    provider: (typeof LLM_PROVIDERS)[number];
    apiKey?: Secret;
    baseUrl?: string;
    fastModel?: string;
    strongModel?: string;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** Parses an env map into a typed Config, or throws ConfigError listing variable names. */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = new Map<string, string>();
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "(env)");
      const missing = issue.code === "invalid_type" && env[name] === undefined;
      problems.set(name, missing ? `${name} is required` : `${name} is invalid`);
    }
    throw new ConfigError([...problems.values()]);
  }
  const e = parsed.data;
  for (const origin of e.ADMIN_ALLOWED_ORIGINS) {
    if (origin === "*" || !URL.canParse(origin)) throw new ConfigError(["ADMIN_ALLOWED_ORIGINS must list explicit origins like http://localhost:3000"]);
  }
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    api: { host: e.API_HOST, port: e.API_PORT },
    worker: { port: e.WORKER_PORT },
    telegram: { webhookPublicUrl: e.TELEGRAM_WEBHOOK_PUBLIC_URL },
    security: { messageEncryptionKey: e.MESSAGE_ENCRYPTION_KEY },
    admin: {
      allowedOrigins: e.ADMIN_ALLOWED_ORIGINS.map((o) => new URL(o).origin),
      sessionTtlHours: e.ADMIN_SESSION_TTL_HOURS,
      sessionIdleMinutes: e.ADMIN_SESSION_IDLE_MINUTES,
      cookieSecure: e.ADMIN_COOKIE_SECURE ?? e.NODE_ENV === "production",
    },
    github: { token: e.GITHUB_TOKEN },
    switch: {
      gatewayUrl: e.SWITCH_GATEWAY_URL,
      adminEmail: e.SWITCH_ADMIN_EMAIL,
      adminPassword: e.SWITCH_ADMIN_PASSWORD,
      agentRegistrationToken: e.AGENT_REGISTRATION_TOKEN,
      bridgeId: e.SWITCH_BRIDGE_ID,
    },
    llm: {
      provider: e.LLM_PROVIDER,
      apiKey: e.LLM_API_KEY,
      baseUrl: e.LLM_BASE_URL,
      fastModel: e.LLM_FAST_MODEL,
      strongModel: e.LLM_STRONG_MODEL,
    },
  };
}
