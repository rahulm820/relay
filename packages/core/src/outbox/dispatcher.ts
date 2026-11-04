import { randomUUID } from "node:crypto";
import { listDueOutbox, withTenant, type Pool } from "@relay/db";
import type { OutboxKind } from "@relay/shared";
import { PermanentFailureError } from "../queue/index.js";
import type { OutboxRegistry } from "./registry.js";

/** Ids, kinds, counts and error codes only. */
export interface OutboxLogEvent {
  event: string;
  outboxId: string;
  tenantId: string;
  kind: OutboxKind;
  traceId?: string;
  attempt?: number;
  outcome?: string;
  errorCode?: string;
}

export interface OutboxDispatcherOptions {
  pool: Pool;
  registry: OutboxRegistry;
  pollIntervalMs?: number;
  batchSize?: number;
  /** Total attempts including crashed ones. After this the row is 'failed' for good. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** A 'processing' row older than this is presumed orphaned by a crash and taken over. Must exceed handler time. */
  leaseSeconds?: number;
  log?: (event: OutboxLogEvent) => void;
}

interface Claimed {
  kind: OutboxKind;
  payload: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
}

const MAX_ERROR_CHARS = 500;

/**
 * Polls for due outbox rows and runs their handlers. Safe to run in several processes: a row is claimed
 * with one compare-and-set UPDATE, so exactly one dispatcher wins it. No transaction is open while a
 * handler runs. Delivery is at least once (a crash after the handler succeeds repeats it after the lease).
 */
export class OutboxDispatcher {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly leaseSeconds: number;
  private readonly log: (event: OutboxLogEvent) => void;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly opts: OutboxDispatcherOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.batchSize = opts.batchSize ?? 10;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 300_000;
    this.leaseSeconds = opts.leaseSeconds ?? 60;
    this.log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  }

  start(): void {
    this.loop = this.run();
  }

  /** Stops polling and waits for the handler currently running, if any. */
  async close(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  /** One polling pass; returns how many rows this dispatcher processed. Exposed for tests. */
  async runOnce(): Promise<number> {
    let processed = 0;
    for (const due of await listDueOutbox(this.opts.pool, this.batchSize, this.leaseSeconds)) {
      if (this.stopping) break;
      if (await this.process(due.id, due.tenantId)) processed++;
    }
    return processed;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (err) {
        console.error(JSON.stringify({ event: "outbox_poll_error", errorCode: errorCodeOf(err) }));
      }
      if (processed === 0) await this.sleep(this.pollIntervalMs);
    }
  }

  private async process(id: string, tenantId: string): Promise<boolean> {
    const token = randomUUID();
    const db = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(this.opts.pool, tenantId, fn);

    const claimed = await db(async (c) =>
      (await c.query<Claimed>(
        `UPDATE outbox SET status = 'processing', attempts = attempts + 1, locked_at = now(), locked_by = $2
         WHERE id = $1 AND ((status = 'pending' AND next_attempt_at <= now())
                         OR (status = 'processing' AND locked_at < now() - make_interval(secs => $3)))
         RETURNING kind, payload, idempotency_key, attempts`,
        [id, token, this.leaseSeconds],
      )).rows[0]);
    if (!claimed) return false; // another dispatcher won the row

    const traceId = typeof claimed.payload["traceId"] === "string" ? claimed.payload["traceId"] : undefined;
    const ids = { outboxId: id, tenantId, kind: claimed.kind, traceId, attempt: claimed.attempts };
    const finish = (sql: string, params: unknown[]) =>
      db((c) => c.query(`UPDATE outbox SET ${sql}, locked_at = NULL, locked_by = NULL WHERE id = $1 AND locked_by = $2`, [id, token, ...params]));

    // A row that keeps crashing its dispatcher burns attempts at claim time and is stopped here.
    if (claimed.attempts > this.maxAttempts) {
      await finish("status = 'failed', last_error = $3", ["max_attempts_exceeded"]);
      this.log({ event: "outbox_failed", ...ids, outcome: "failed", errorCode: "max_attempts_exceeded" });
      return true;
    }
    const handler = this.opts.registry.get(claimed.kind);
    if (!handler) {
      await finish("status = 'failed', last_error = $3", ["no_handler_registered"]);
      this.log({ event: "outbox_failed", ...ids, outcome: "failed", errorCode: "no_handler_registered" });
      return true;
    }
    try {
      const result = await handler({
        outboxId: id, tenantId, kind: claimed.kind, idempotencyKey: claimed.idempotency_key,
        payload: claimed.payload, attempt: claimed.attempts, traceId,
      });
      await finish("status = 'done', last_error = $3", [result?.note ?? null]);
      this.log({ event: "outbox_done", ...ids, outcome: "done" });
    } catch (err) {
      const message = (err instanceof Error ? err.message : "non-error thrown").slice(0, MAX_ERROR_CHARS);
      if (err instanceof PermanentFailureError || claimed.attempts >= this.maxAttempts) {
        await finish("status = 'failed', last_error = $3", [message]);
        this.log({ event: "outbox_failed", ...ids, outcome: "failed", errorCode: errorCodeOf(err) });
      } else {
        const delayMs = Math.min(this.backoffBaseMs * 2 ** (claimed.attempts - 1), this.backoffMaxMs);
        await finish("status = 'pending', last_error = $3, next_attempt_at = now() + make_interval(secs => $4)", [message, delayMs / 1000]);
        this.log({ event: "outbox_retry", ...ids, outcome: "retry", errorCode: errorCodeOf(err) });
      }
    }
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      if (this.stopping) this.wake();
    });
  }
}

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.name : "unknown";
}
