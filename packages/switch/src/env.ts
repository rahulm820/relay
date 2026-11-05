import { Secret } from "@relay/shared";
import { SwitchClient } from "./client.js";

/** Reads the SWITCH_* variables the CLIs need. Reports missing NAMES only. */
export function loadSwitchEnv(env: Readonly<Record<string, string | undefined>>):
  | { ok: false; missing: string[] }
  | { ok: true; client: SwitchClient; triagerAgent: string; notifierAgent: string } {
  const missing = ["SWITCH_GATEWAY_URL", "SWITCH_ADMIN_EMAIL", "SWITCH_ADMIN_PASSWORD"].filter((k) => !env[k]);
  if (missing.length) return { ok: false, missing };
  const notifierAgent = env["SWITCH_NOTIFIER_AGENT"] || "relay-notifier";
  const key = env["SWITCH_NOTIFIER_API_KEY"];
  return {
    ok: true,
    triagerAgent: env["SWITCH_TRIAGER_AGENT"] || "relay-triager",
    notifierAgent,
    client: new SwitchClient({
      gatewayUrl: env["SWITCH_GATEWAY_URL"]!,
      ...(env["SWITCH_API_URL"] ? { apiUrl: env["SWITCH_API_URL"] } : {}),
      email: env["SWITCH_ADMIN_EMAIL"]!,
      password: new Secret(env["SWITCH_ADMIN_PASSWORD"]!),
      ...(key ? { notifier: { name: notifierAgent, apiKey: new Secret(key) } } : {}),
    }),
  };
}
