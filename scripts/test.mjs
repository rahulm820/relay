#!/usr/bin/env node
// `npm test`: the whole test suite against a clean, throwaway Postgres and Redis.
//
//   1. start docker-compose.test.yml (skipped when TEST_ADMIN_URL and TEST_REDIS_URL point at services you run yourself,
//      for example CI service containers)
//   2. build the server packages (the E2E suite runs the built API and worker)
//   3. run each workspace's tests, one after another, and print one summary table
//   4. run the golden-set extraction smoke check (a measurement: skipped without an LLM key, never fails the run)
//   5. remove the containers, even after a failure or Ctrl-C
//
// Options: --keep (leave the containers running), --no-build, --only=shared,core (run only these workspaces).
// No dependencies on purpose: this runs before anything is installed that could be broken.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",").filter(Boolean);
const COMPOSE = ["compose", "-f", "docker-compose.test.yml"];
const PG_PASSWORD = process.env.RELAY_TEST_PG_PASSWORD ?? "relay-test-only";

const external = Boolean(process.env.TEST_ADMIN_URL && process.env.TEST_REDIS_URL);
let composeUp = false;

const log = (msg) => console.log(`\n\u001b[1m${msg}\u001b[0m`);
const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: root, stdio: "inherit", ...o });

function teardown() {
  if (!composeUp || flag("--keep")) return;
  composeUp = false;
  log("Removing the test containers");
  spawnSync("docker", [...COMPOSE, "down", "-v", "--remove-orphans"], { cwd: root, stdio: "inherit" });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { teardown(); process.exit(130); });

/** Workspaces that have a test script, dependencies first and the end-to-end suite last. */
function testWorkspaces() {
  const names = [];
  for (const dir of ["packages", "apps"]) {
    for (const d of readdirSync(join(root, dir), { withFileTypes: true })) {
      const file = join(root, dir, d.name, "package.json");
      if (!d.isDirectory() || !existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.scripts?.test) names.push(pkg.name);
    }
  }
  const order = ["@relay/shared", "@relay/db", "@relay/trackers", "@relay/llm", "@relay/core", "@relay/channels", "@relay/switch", "@relay/api", "@relay/web", "@relay/e2e"];
  const rank = (n) => (order.includes(n) ? order.indexOf(n) : order.length - 1.5);
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).filter((n) => !only || only.some((o) => n === o || n === `@relay/${o}`));
}

/** Runs a command, streams its output, and returns { code, out } so the summary can read the test counts. */
function capture(cmd, a, env = process.env) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, a, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const tee = (stream) => (chunk) => { out += chunk; stream.write(chunk); };
    child.stdout.on("data", tee(process.stdout));
    child.stderr.on("data", tee(process.stderr));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const count = (out, key) => Number(new RegExp(`^ℹ ${key} (\\d+)`, "m").exec(out)?.[1] ?? NaN);

async function main() {
  if (!external) {
    if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status !== 0) {
      console.error("Docker Compose is required to run the tests (or set TEST_ADMIN_URL and TEST_REDIS_URL to services you run yourself).");
      return 1;
    }
    log("Starting a clean Postgres and Redis (docker-compose.test.yml)");
    spawnSync("docker", [...COMPOSE, "down", "-v", "--remove-orphans"], { cwd: root, stdio: "ignore" }); // drop anything stale
    const up = sh("docker", [...COMPOSE, "up", "-d", "--wait"], { env: { ...process.env, RELAY_TEST_PG_PASSWORD: PG_PASSWORD } });
    composeUp = true;
    if (up.status !== 0) { console.error("The test containers did not become healthy."); return 1; }
  }
  const env = {
    ...process.env,
    TEST_ADMIN_URL: process.env.TEST_ADMIN_URL ?? `postgres://relay:${PG_PASSWORD}@127.0.0.1:5434/postgres`,
    TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6380",
  };

  if (!flag("--no-build")) {
    log("Building the server packages");
    if (sh("npm", ["run", "build:server"]).status !== 0) { console.error("Build failed."); return 1; }
  }

  const results = [];
  for (const name of testWorkspaces()) {
    log(`Testing ${name}`);
    const started = Date.now();
    const { code, out } = await capture("npm", ["run", "test", "-w", name], env);
    results.push({ name, code, tests: count(out, "tests"), pass: count(out, "pass"), fail: count(out, "fail"), seconds: ((Date.now() - started) / 1000).toFixed(1) });
  }

  if (!only) {
    log("Golden-set extraction smoke check (a measurement, not a gate)");
    await capture("npm", ["run", "golden", "-w", "@relay/llm"], env);
  }

  log("Summary");
  const pad = (v, n) => String(v).padEnd(n);
  for (const r of results) {
    const mark = r.code === 0 ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${pad(r.name, 18)} ${pad(Number.isNaN(r.tests) ? "?" : `${r.pass}/${r.tests} tests`, 16)} ${r.seconds}s`);
  }
  const failed = results.filter((r) => r.code !== 0);
  console.log(failed.length === 0 ? "\nAll suites passed." : `\n${failed.length} suite(s) failed: ${failed.map((r) => r.name).join(", ")}`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => { teardown(); process.exit(code); }, (err) => { console.error(err); teardown(); process.exit(1); });
