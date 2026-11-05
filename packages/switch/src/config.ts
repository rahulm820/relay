import type { Config } from "@relay/shared";
import { SwitchClient } from "./client.js";

/** Builds the client from validated config, or reports which settings are missing (names only). */
export function switchFromConfig(c: Config["switch"]): { client: SwitchClient | null; missing: string[] } {
  const missing = [
    !c.adminEmail && "SWITCH_ADMIN_EMAIL",
    !c.adminPassword && "SWITCH_ADMIN_PASSWORD",
    !c.notifierApiKey && "SWITCH_NOTIFIER_API_KEY",
  ].filter((m): m is string => !!m);
  if (missing.length > 0) return { client: null, missing };
  return {
    missing,
    client: new SwitchClient({
      gatewayUrl: c.gatewayUrl,
      ...(c.apiUrl ? { apiUrl: c.apiUrl } : {}),
      email: c.adminEmail!,
      password: c.adminPassword!,
      notifier: { name: c.notifierAgent, apiKey: c.notifierApiKey! },
    }),
  };
}
