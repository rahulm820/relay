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
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    api: { host: e.API_HOST, port: e.API_PORT },
    worker: { port: e.WORKER_PORT },
    telegram: { webhookPublicUrl: e.TELEGRAM_WEBHOOK_PUBLIC_URL },
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
