import { QueueEnvelopeSchema, type QueueEnvelope, type QueueStage } from "@relay/shared";
import type { Redis } from "ioredis";

export const DLQ_STREAM = "q.dlq";
export const streamKey = (stage: QueueStage) => `q:${stage}`;
export const groupName = (stage: QueueStage) => `${stage}-workers`;
const idemKey = (stage: QueueStage, key: string) => `idem:${stage}:${key}`;

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// KEYS[1] = idempotency key (may be ""), KEYS[2] = stream. ARGV[1] = ttl, ARGV[2] = envelope JSON,
// ARGV[3] = idempotency key text (stored on the entry for handlers). Runs atomically, so a crash can
// never leave the key set without the entry or the entry added without the key.
// Returns {1, newId} when added, {0, existingId} for a duplicate.
const ENQUEUE_SCRIPT = `
if KEYS[1] ~= '' then
  local existing = redis.call('GET', KEYS[1])
  if existing then return {0, existing} end
end
local id = redis.call('XADD', KEYS[2], '*', 'data', ARGV[2], 'idem', ARGV[3])
if KEYS[1] ~= '' then redis.call('SET', KEYS[1], id, 'EX', tonumber(ARGV[1])) end
return {1, id}
`;

export interface EnqueueOptions {
  /**
   * Identifies the logical message. Enqueueing the same (stage, key) again within the TTL is a no-op that
   * returns the original entry id. Convention: the platform message id, e.g. `tg:{botId}:{update_id}`,
   * or for derived jobs `{ticketId}:{stage}`. Omit to always enqueue (e.g. replays).
   */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  entryId: string;
  /** True when the key had been seen: nothing was added. */
  duplicate: boolean;
}

export class QueueProducer {
  constructor(
    private readonly redis: Redis,
    private readonly idempotencyTtlSeconds = DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  ) {}

  /** Validates the envelope (throws ZodError if invalid), then adds it to the stage's stream. */
  async enqueue(envelope: QueueEnvelope, opts: EnqueueOptions = {}): Promise<EnqueueResult> {
    const valid = QueueEnvelopeSchema.parse(envelope);
    const key = opts.idempotencyKey ?? "";
    const [added, entryId] = (await this.redis.eval(
      ENQUEUE_SCRIPT,
      2,
      key ? idemKey(valid.stage, key) : "",
      streamKey(valid.stage),
      String(this.idempotencyTtlSeconds),
      JSON.stringify(valid),
      key,
    )) as [number, string];
    return { entryId, duplicate: added === 0 };
  }
}
