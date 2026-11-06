// Starts the REAL API and worker (the built dist, as in production) as child processes against the throwaway Postgres
// and Redis, with every external host redirected to a local mock by the preload shim. Black-box: tests talk to the
// API over HTTP and look at the database and the mocks, never at the processes' internals.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { TestDb } from "@relay/core/testing";
import type { Mocks } from "./mocks.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const API_ENTRY = `${root}apps/api/dist/server.js`;
const WORKER_ENTRY = `${root}apps/worker/dist/server.js`;
const PRELOAD = fileURLToPath(new URL("../preload/network-boundary.mjs", import.meta.url));

export const E2E_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
export const E2E_BOT_TOKEN = "123456:FAKE-E2E-BOT-TOKEN";
export const E2E_GITHUB_TOKEN = "fake-e2e-github-token";
export const E2E_LLM_KEY = "fake-e2e-llm-key";

export interface StackOptions {
  db: TestDb;
  mocks: Mocks;
  redisUrl: string;
  /** The reconcile job; off unless a test is about it (a background pass could race a scenario). */
  reconcile?: { intervalSeconds: number; graceSeconds: number };
}

export interface Stack {
  apiUrl: string;
  workerUrl: string;
  /** Every stdout/stderr line the two processes wrote. They contain ids and codes, never message text or secrets. */
  logs(): string[];
  /** Hosts the offline guard refused. Always empty in a healthy run. */
  blockedHosts(): string[];
  /** SIGTERM both and wait; returns their exit codes (0 = clean shutdown). */
  stop(): Promise<{ api: number | null; worker: number | null }>;
}

export function assertBuilt(): void {
  for (const f of [API_ENTRY, WORKER_ENTRY]) {
    if (!existsSync(f)) throw new Error(`${f} is missing. Run \`npm run build:server\` first (the E2E suite runs the built API and worker).`);
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Proc { child: ChildProcess; lines: string[]; exited: Promise<number | null> }

function launch(name: string, entry: string, env: Record<string, string>): Proc {
  const lines: string[] = [];
  // Only PATH is inherited: the processes get exactly the configuration given here.
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: `--import=${PRELOAD}`, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (chunk: Buffer) => { for (const l of String(chunk).split("\n")) if (l.trim()) lines.push(`[${name}] ${l}`); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, lines, exited };
}

async function ready(url: string, p: Proc, what: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (p.child.exitCode !== null) throw new Error(`${what} exited during startup (code ${p.child.exitCode}). Last log lines:\n${p.lines.slice(-8).join("\n")}`);
    try { if ((await fetch(`${url}/healthz`)).ok) return; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${what} did not become ready. Last log lines:\n${p.lines.slice(-8).join("\n")}`);
}

export async function startStack(o: StackOptions): Promise<Stack> {
  assertBuilt();
  const [apiPort, workerPort] = [await freePort(), await freePort()];
  const shared = {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    REDIS_URL: o.redisUrl,
    MESSAGE_ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    WORKER_PORT: String(workerPort),
    LLM_PROVIDER: "gemini",
    LLM_API_KEY: E2E_LLM_KEY,
    LLM_FAST_MODEL: "gemini-e2e-fast",
    SWITCH_GATEWAY_URL: o.mocks.switchGateway.gatewayUrl,
    SWITCH_ADMIN_EMAIL: o.mocks.switchGateway.email,
    SWITCH_ADMIN_PASSWORD: o.mocks.switchGateway.password,
    SWITCH_NOTIFIER_API_KEY: o.mocks.notifierKey,
    GITHUB_TOKEN: E2E_GITHUB_TOKEN,
    E2E_BOT_TOKEN,
    RECONCILE_INTERVAL_SECONDS: String(o.reconcile?.intervalSeconds ?? 0),
    RECONCILE_GRACE_SECONDS: String(o.reconcile?.graceSeconds ?? 300),
    E2E_HOST_MAP: JSON.stringify(o.mocks.hostMap),
  };
  const api = launch("api", API_ENTRY, { ...shared, DATABASE_URL: o.db.urls.api });
  const worker = launch("worker", WORKER_ENTRY, { ...shared, DATABASE_URL: o.db.urls.worker });
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  try {
    await Promise.all([ready(apiUrl, api, "the API"), ready(workerUrl, worker, "the worker")]);
  } catch (err) {
    api.child.kill("SIGKILL"); worker.child.kill("SIGKILL");
    throw err;
  }
  const all = () => [...api.lines, ...worker.lines];
  return {
    apiUrl, workerUrl,
    logs: all,
    blockedHosts: () => all().flatMap((l) => { const m = /"event":"e2e_offline_guard_blocked","host":"([^"]+)"/.exec(l); return m ? [m[1]!] : []; }),
    async stop() {
      api.child.kill("SIGTERM"); worker.child.kill("SIGTERM");
      const timer = setTimeout(() => { api.child.kill("SIGKILL"); worker.child.kill("SIGKILL"); }, 10_000);
      const [a, w] = await Promise.all([api.exited, worker.exited]);
      clearTimeout(timer);
      return { api: a, worker: w };
    },
  };
}
