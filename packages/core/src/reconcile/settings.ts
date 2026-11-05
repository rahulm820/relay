import { ConfigError } from "@relay/shared";

export interface ReconcileSettings {
  /** Seconds between passes; 0 turns the job off. */
  intervalSeconds: number;
  graceSeconds: number;
  staleSeconds: number;
  retryBudget: number;
  backlogAlertSeconds: number;
}

const SPEC: ReadonlyArray<{ key: string; field: keyof ReconcileSettings; fallback: number; min: number; max: number }> = [
  { key: "RECONCILE_INTERVAL_SECONDS", field: "intervalSeconds", fallback: 60, min: 0, max: 86_400 },
  { key: "RECONCILE_GRACE_SECONDS", field: "graceSeconds", fallback: 300, min: 0, max: 86_400 },
  { key: "RECONCILE_STALE_SECONDS", field: "staleSeconds", fallback: 3600, min: 60, max: 604_800 },
  { key: "GITHUB_SYNC_RETRY_BUDGET", field: "retryBudget", fallback: 8, min: 1, max: 100 },
  { key: "SYNC_BACKLOG_ALERT_SECONDS", field: "backlogAlertSeconds", fallback: 600, min: 1, max: 604_800 },
];

/**
 * Reads the job's tuning from the environment. Defaults suit the demo (a pass a minute, 5 minutes of grace before
 * touching a row the pipeline may still be working on). A bad value throws ConfigError naming the variable only.
 */
export function reconcileSettingsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ReconcileSettings {
  const out = {} as Record<keyof ReconcileSettings, number>;
  const problems: string[] = [];
  for (const s of SPEC) {
    const raw = env[s.key];
    if (raw === undefined || raw.trim() === "") { out[s.field] = s.fallback; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < s.min || n > s.max) problems.push(`${s.key} must be an integer between ${s.min} and ${s.max}`);
    else out[s.field] = n;
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return out;
}
