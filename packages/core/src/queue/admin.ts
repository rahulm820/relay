import { QueueEnvelopeSchema, type QueueStage } from "@relay/shared";
import type { Redis } from "ioredis";
import { DLQ_STREAM, QueueProducer, groupName, streamKey } from "./producer.js";

export interface QueueStats {
  /** Entries still in the stage stream (waiting or pending). */
  length: number;
  /** Delivered but not yet acknowledged. */
  pending: number;
  /** Entries in q.dlq (all stages). */
  deadLetters: number;
}

export async function queueStats(redis: Redis, stage: QueueStage): Promise<QueueStats> {
  const [length, deadLetters, pending] = await Promise.all([
    redis.xlen(streamKey(stage)),
    redis.xlen(DLQ_STREAM),
    redis.xpending(streamKey(stage), groupName(stage)).catch(() => [0]), // group may not exist yet
  ]);
  return { length, deadLetters, pending: Number((pending as unknown[])[0] ?? 0) };
}

export interface DeadLetter {
  id: string;
  stage: string;
  entryId: string;
  attempts: number;
  errorCode: string;
  errorMessage: string;
  failedAt: string;
  idempotencyKey: string;
  envelope: string;
}

/** Oldest-first view of the dead-letter stream. Contains envelopes: restrict who may call it. */
export async function listDeadLetters(redis: Redis, count = 20): Promise<DeadLetter[]> {
  const rows = await redis.xrange(DLQ_STREAM, "-", "+", "COUNT", count);
  return rows.map(([id, f]) => {
    const m = Object.fromEntries(Array.from({ length: f.length / 2 }, (_, i) => [f[2 * i]!, f[2 * i + 1]!]));
    return { id, ...m, attempts: Number(m["attempts"]) } as DeadLetter;
  });
}

/** Re-enqueues a dead letter's envelope (without an idempotency key) and removes it from the DLQ. */
export async function replayDeadLetter(redis: Redis, dlqId: string): Promise<string> {
  const rows = await redis.xrange(DLQ_STREAM, dlqId, dlqId);
  const fields = rows[0]?.[1];
  if (!fields) throw new Error("dead letter not found");
  const envelope = QueueEnvelopeSchema.parse(JSON.parse(fields[fields.indexOf("envelope") + 1] ?? ""));
  const { entryId } = await new QueueProducer(redis).enqueue(envelope);
  await redis.xdel(DLQ_STREAM, dlqId);
  return entryId;
}
