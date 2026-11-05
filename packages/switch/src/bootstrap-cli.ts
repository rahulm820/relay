// Usage: npm run switch:bootstrap -w @relay/switch [-- --rotate-keys]
// Env: SWITCH_GATEWAY_URL, SWITCH_ADMIN_EMAIL, SWITCH_ADMIN_PASSWORD (+ optional agent names). Prints no secrets.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSwitchEnv } from "./env.js";
import { bootstrapSwitch } from "./bootstrap.js";

const env = loadSwitchEnv(process.env);
if (!env.ok) {
  console.error(`missing: ${env.missing.join(", ")}`);
  process.exit(1);
}
// npm runs scripts inside the workspace; INIT_CWD is where the person ran npm (the repo root).
const file = join(process.env["INIT_CWD"] ?? process.cwd(), ".env.switch");

try {
  await bootstrapSwitch({
    client: env.client,
    triagerAgent: env.triagerAgent,
    notifierAgent: env.notifierAgent,
    haveNotifierKey: Boolean(process.env["SWITCH_NOTIFIER_API_KEY"]),
    rotateKey: process.argv.includes("--rotate-keys"),
    out: (l) => console.log(l),
    storeNotifierKey: async (key) => {
      const kept = (await readFile(file, "utf8").catch(() => "")).split("\n").filter((l) => l && !l.startsWith("SWITCH_NOTIFIER_API_KEY="));
      await writeFile(file, [...kept, `SWITCH_NOTIFIER_API_KEY=${key.reveal()}`, ""].join("\n"), { mode: 0o600 });
      await chmod(file, 0o600);
      console.log("next: load it into your shell with:  set -a; . ./.env.switch; set +a   (file is git-ignored, mode 600)");
    },
  });
} catch (err) {
  console.error(`failed: ${(err as { code?: string }).code ?? "error"}`);
  process.exitCode = 1;
}
