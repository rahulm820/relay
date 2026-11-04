import { QUEUE_STAGES, type PipelineStage, type QueueStage } from "@relay/shared";
import type { Client } from "@relay/db";

/** The stage that follows `stage`, or undefined after the last one (`notify`). */
export function nextStage(stage: QueueStage): PipelineStage | undefined {
  return QUEUE_STAGES[QUEUE_STAGES.indexOf(stage) + 1] as PipelineStage | undefined;
}

/** Queue idempotency key for the job a stage hands to the next one: `{messageId}:{stage}`. */
export const derivedJobKey = (messageId: string, stage: QueueStage): string => `${messageId}:${stage}`;

export interface StageContext {
  tenantId: string;
  /** From the stored message, not from the queue envelope. */
  conversationId: string;
  messageId: string;
  traceId: string;
  stage: PipelineStage;
  /** 1-based queue delivery attempt, counting earlier crashed deliveries. */
  attempt: number;
  /** Results of the stages that already finished, keyed by stage name. */
  results: Readonly<Record<string, unknown>>;
  /**
   * Runs `fn` in a tenant-scoped transaction (RLS applies). Open it only around DB work, never
   * across an LLM or network call. Writes and outbox rows made in one `db()` call commit together.
   */
  db: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
  /** Aborted when the stage times out; pass it to fetch() and similar. */
  signal: AbortSignal;
}

export interface StageOutcome {
  /** JSON-serialisable output, stored in pipeline_runs.stage_results[stage]. Must be safe to keep. */
  result: Record<string, unknown>;
  /** Set to end the pipeline here (e.g. duplicate, off-topic); the run completes with this reason. */
  stop?: string;
}

/**
 * A stage implementation. Must be idempotent: it can run again after a crash between its side
 * effects and the stored result. Throw to retry (transient), PermanentFailureError to dead-letter.
 */
export type StageHandler = (ctx: StageContext) => Promise<StageOutcome>;

export class StageRegistry {
  private readonly handlers = new Map<PipelineStage, StageHandler>();

  /** Registers or replaces the handler for a stage. */
  register(stage: PipelineStage, handler: StageHandler): this {
    this.handlers.set(stage, handler);
    return this;
  }

  get(stage: PipelineStage): StageHandler | undefined {
    return this.handlers.get(stage);
  }
}
