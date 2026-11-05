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

  /**
   * LOCAL DEVELOPMENT ONLY. Lets the API treat every caller as one fixed tenant, because real
   * authentication (Issue #17) does not exist yet. Off by default, refused in production, and the API
   * additionally refuses to start with it unless it listens on a loopback address.
   */
  DEV_AUTH_ENABLED: z.preprocess(empty, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),
  DEV_AUTH_TENANT_ID: z.preprocess(empty, z.uuid().optional()),

  GITHUB_TOKEN: secret,

  SWITCH_GATEWAY_URL: z.preprocess(empty, z.url().default("http://localhost:8000/gateway")),
  SWITCH_ADMIN_EMAIL: optionalString,
  SWITCH_ADMIN_PASSWORD: secret,
  AGENT_REGISTRATION_TOKEN: secret,
  SWITCH_BRIDGE_ID: optionalString,
  /** Switch's agent API (where agents post). Defaults to SWITCH_GATEWAY_URL without its trailing /gateway. */
  SWITCH_API_URL: optionalUrl,
  /** Names of the two agents every ticket room contains. Created by `npm run switch:bootstrap`. */
  SWITCH_TRIAGER_AGENT: z.preprocess(empty, z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).default("relay-triager")),
  SWITCH_NOTIFIER_AGENT: z.preprocess(empty, z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).default("relay-notifier")),
  /** API key of the notifier agent (printed to .env.switch by the bootstrap, never shown). Posts room messages. */
  SWITCH_NOTIFIER_API_KEY: secret,

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
  devAuth: { enabled: boolean; tenantId?: string };
  github: { token?: Secret };
  switch: {
    gatewayUrl: string;
    adminEmail?: string;
    adminPassword?: Secret;
    agentRegistrationToken?: Secret;
    bridgeId?: string;
    apiUrl?: string;
    triagerAgent: string;
    notifierAgent: string;
    notifierApiKey?: Secret;
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
  if (e.DEV_AUTH_ENABLED && !e.DEV_AUTH_TENANT_ID) throw new ConfigError(["DEV_AUTH_TENANT_ID is required when DEV_AUTH_ENABLED=true"]);
  if (e.DEV_AUTH_ENABLED && e.NODE_ENV === "production") throw new ConfigError(["DEV_AUTH_ENABLED is not allowed when NODE_ENV=production"]);
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    api: { host: e.API_HOST, port: e.API_PORT },
    worker: { port: e.WORKER_PORT },
    telegram: { webhookPublicUrl: e.TELEGRAM_WEBHOOK_PUBLIC_URL },
    security: { messageEncryptionKey: e.MESSAGE_ENCRYPTION_KEY },
    devAuth: { enabled: e.DEV_AUTH_ENABLED, tenantId: e.DEV_AUTH_TENANT_ID },
    github: { token: e.GITHUB_TOKEN },
    switch: {
      gatewayUrl: e.SWITCH_GATEWAY_URL,
      adminEmail: e.SWITCH_ADMIN_EMAIL,
      adminPassword: e.SWITCH_ADMIN_PASSWORD,
      agentRegistrationToken: e.AGENT_REGISTRATION_TOKEN,
      bridgeId: e.SWITCH_BRIDGE_ID,
      apiUrl: e.SWITCH_API_URL,
      triagerAgent: e.SWITCH_TRIAGER_AGENT,
      notifierAgent: e.SWITCH_NOTIFIER_AGENT,
      notifierApiKey: e.SWITCH_NOTIFIER_API_KEY,
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
