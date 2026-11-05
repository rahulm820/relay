import { QueueEnvelopeSchema, type QueueEnvelope, type QueueStage } from "@relay/shared";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { DLQ_CODES, PermanentFailureError } from "./errors.js";
import { DLQ_STREAM, groupName, streamKey } from "./producer.js";

export interface HandlerContext {
  entryId: string;
  /** 1-based attempt number, counting earlier deliveries that crashed or failed. */
  attempt: number;
  idempotencyKey: string | undefined;
}

/** Throw to retry; throw PermanentFailureError to dead-letter immediately. Must be idempotent. */
export type QueueHandler = (envelope: QueueEnvelope, ctx: HandlerContext) => Promise<void>;

/** Never contains payloads: ids, stage names, counts and error codes only. */
export interface QueueLogEvent {
  event: string;
  stage: QueueStage;
  entryId?: string;
  traceId?: string;
  tenantId?: string;
  attempt?: number;
  outcome?: string;
  errorCode?: string;
}

export interface ConsumerOptions {
  stage: QueueStage;
  handler: QueueHandler;
  consumerName?: string;
  blockMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** An entry pending longer than this is reclaimed from its (presumed dead) consumer. */
  minIdleMs?: number;
  reclaimIntervalMs?: number;
  log?: (event: QueueLogEvent) => void;
}

const MAX_ERROR_CHARS = 500;
const MAX_ENVELOPE_CHARS = 8000;

export class QueueConsumer {
  private readonly stream: string;
  private readonly group: string;
  private readonly name: string;
  private readonly blockMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly minIdleMs: number;
  private readonly reclaimIntervalMs: number;
  private readonly log: (event: QueueLogEvent) => void;
  private blocking: Redis | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  /** `redis` runs normal commands; blocking reads use a duplicate connection that close() quits. */
  constructor(
    private readonly redis: Redis,
    private readonly opts: ConsumerOptions,
  ) {
    this.stream = streamKey(opts.stage);
    this.group = groupName(opts.stage);
    this.name = opts.consumerName ?? `${process.pid}-${randomUUID().slice(0, 8)}`;
    this.blockMs = opts.blockMs ?? 2000;
    this.batchSize = opts.batchSize ?? 10;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.minIdleMs = opts.minIdleMs ?? 60_000;
    this.reclaimIntervalMs = opts.reclaimIntervalMs ?? 5000;
    this.log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
    // A retrying entry stays pending; if it idled past minIdleMs another consumer could steal it.
    let budget = 0;
    for (let n = 1; n < this.maxAttempts; n++) budget += this.backoff(n);
    if (this.minIdleMs <= budget) throw new Error("minIdleMs must exceed the total retry backoff budget");
  }

  private backoff(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
  }

  /** Creates the group if missing (from the beginning of the stream) and starts the background loop. */
  async start(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", this.stream, this.group, "0", "MKSTREAM");
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith("BUSYGROUP")) throw err;
    }
    this.blocking = this.redis.duplicate();
    this.blocking.on("error", () => undefined); // surfaced through command rejections in the loop
    this.loop = this.run();
  }

  /** Stops reading, lets the in-flight handler finish, then closes the blocking connection. */
  async close(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.blocking?.disconnect();
  }

  private async run(): Promise<void> {
    let nextReclaim = 0;
    let errorDelay = 0;
    while (!this.stopping) {
      try {
        if (Date.now() >= nextReclaim) {
          await this.reclaim();
          nextReclaim = Date.now() + this.reclaimIntervalMs;
        }
        const res = (await this.blocking!.xreadgroup(
          "GROUP", this.group, this.name, "COUNT", this.batchSize, "BLOCK", this.blockMs, "STREAMS", this.stream, ">",
        )) as [string, [string, string[]][]][] | null;
        for (const [id, fields] of res?.[0]?.[1] ?? []) {
          if (this.stopping) break; // read but unprocessed entries stay pending and are reclaimed later
          await this.handle(id, fields, 0);
        }
        errorDelay = 0;
      } catch (err) {
        errorDelay = Math.min(errorDelay ? errorDelay * 2 : 250, 5000);
        this.log({ event: "redis_error", stage: this.opts.stage, errorCode: errorCodeOf(err) });
        await this.sleep(errorDelay);
      }
    }
  }

  /** Takes over entries whose consumer has been silent for minIdleMs, and handles them. */
  private async reclaim(): Promise<void> {
    let cursor = "0";
    do {
      const [next, entries] = (await this.redis.xautoclaim(
        this.stream, this.group, this.name, this.minIdleMs, cursor, "COUNT", this.batchSize,
      )) as [string, [string, string[]][]];
      cursor = next;
      for (const [id, fields] of entries) {
        if (this.stopping) return;
        // XAUTOCLAIM bumped the delivery counter; deliveries - 1 earlier ones never completed.
        const pending = (await this.redis.xpending(this.stream, this.group, id, id, 1)) as [string, string, number, number][];
        await this.handle(id, fields, Math.max((pending[0]?.[3] ?? 1) - 1, 0));
      }
    } while (cursor !== "0-0" && cursor !== "0" && !this.stopping); // Redis 7 ends the scan with "0-0"
  }

  private async handle(entryId: string, fields: string[], priorAttempts: number): Promise<void> {
    const stage = this.opts.stage;
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
    const raw = map.get("data") ?? "";
    const idempotencyKey = map.get("idem") || undefined;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.deadLetter(entryId, raw, idempotencyKey, priorAttempts, DLQ_CODES.malformed, "entry is not valid JSON");
    }
    const parsed = QueueEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      return this.deadLetter(entryId, raw, idempotencyKey, priorAttempts, DLQ_CODES.invalidEnvelope, "entry does not match QueueEnvelope");
    }
    const envelope = parsed.data;
    const ids = { stage, entryId, traceId: envelope.traceId, tenantId: envelope.tenantId };
    if (envelope.stage !== stage) {
      return this.deadLetter(entryId, raw, idempotencyKey, priorAttempts, DLQ_CODES.stageMismatch, "envelope stage differs from stream stage", ids);
    }

    let attempt = priorAttempts;
    for (;;) {
      attempt++;
      try {
        await this.opts.handler(envelope, { entryId, attempt, idempotencyKey });
        await this.redis.multi().xack(this.stream, this.group, entryId).xdel(this.stream, entryId).exec();
        this.log({ event: "processed", ...ids, attempt, outcome: "ok" });
        return;
      } catch (err) {
        if (err instanceof PermanentFailureError) {
          return this.deadLetter(entryId, raw, idempotencyKey, attempt, err.code, err.message, ids);
        }
        if (attempt >= this.maxAttempts) {
          return this.deadLetter(entryId, raw, idempotencyKey, attempt, DLQ_CODES.handlerError, errorMessageOf(err), ids);
        }
        this.log({ event: "retry", ...ids, attempt, outcome: "retry", errorCode: errorCodeOf(err) });
        if (!(await this.sleep(this.backoff(attempt)))) {
          this.log({ event: "abandoned", ...ids, attempt, outcome: "shutdown" }); // stays pending
          return;
        }
      }
    }
  }

  /** Copies the entry to q.dlq and removes it from the stage stream in one transaction. */
  private async deadLetter(
    entryId: string, rawEnvelope: string, idempotencyKey: string | undefined, attempts: number,
    errorCode: string, errorMessage: string, ids?: Partial<QueueLogEvent>,
  ): Promise<void> {
    await this.redis
      .multi()
      .xadd(
        DLQ_STREAM, "*",
        "stage", this.opts.stage, "entryId", entryId, "attempts", String(attempts),
        "errorCode", errorCode, "errorMessage", errorMessage.slice(0, MAX_ERROR_CHARS),
        "failedAt", new Date().toISOString(), "idempotencyKey", idempotencyKey ?? "",
        "envelope", rawEnvelope.slice(0, MAX_ENVELOPE_CHARS),
      )
      .xack(this.stream, this.group, entryId)
      .xdel(this.stream, entryId)
      .exec();
    this.log({ event: "dead_lettered", stage: this.opts.stage, entryId, ...ids, attempt: attempts, outcome: "dlq", errorCode });
  }

  /** Sleeps unless close() is called; resolves false when woken by shutdown. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(true); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(false); };
      if (this.stopping) this.wake();
    });
  }
}

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.name : "unknown";
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : "non-error thrown";
}
