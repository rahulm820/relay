import { withTenant, type Client, type Pool } from "@relay/db";
import { type PipelineStage, type QueueStage } from "@relay/shared";
import { z } from "zod";
import { PermanentFailureError, type HandlerContext, type QueueHandler, type QueueProducer } from "../queue/index.js";
import { derivedJobKey, nextStage, type StageRegistry } from "./stages.js";

/** Queue payloads carry ids only; the message itself is read from Postgres. */
export const StagePayloadSchema = z.object({ messageId: z.uuid() });

/** Ids, stage names, counts and outcomes only; never message text or payloads. */
export interface OrchestratorLogEvent {
  event: string;
  stage: QueueStage;
  traceId: string;
  tenantId: string;
  messageId: string;
  outcome?: string;
}

export interface RunnerDeps {
  pool: Pool;
  producer: QueueProducer;
  stages: StageRegistry;
  stageTimeoutMs: number;
  log: (event: OrchestratorLogEvent) => void;
}

interface RunRow {
  id: string;
  status: "running" | "completed";
  stage_results: Record<string, unknown>;
  stop_reason: string | null;
}

/** Creates the run for a message if it does not exist (idempotent) and returns it. */
async function loadOrCreateRun(c: Client, tenantId: string, messageId: string, traceId: string): Promise<RunRow> {
  await c.query(
    `INSERT INTO pipeline_runs (tenant_id, message_id, conversation_id, trace_id)
     SELECT $1, m.id, m.conversation_id, $3 FROM messages m WHERE m.id = $2
     ON CONFLICT (message_id) DO NOTHING`,
    [tenantId, messageId, traceId],
  );
  const { rows } = await c.query<RunRow & { conversation_id: string }>(
    "SELECT id, status, stage_results, stop_reason, conversation_id FROM pipeline_runs WHERE message_id = $1",
    [messageId],
  );
  if (!rows[0]) throw new PermanentFailureError("message not found for this tenant", "message_not_found");
  return rows[0];
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const work = run(controller.signal);
  work.catch(() => undefined); // if the timeout wins, the abandoned work must not become an unhandled rejection
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("stage timed out"), { code: "stage_timeout" }));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The queue handler for one stage. Order of events for a stage (persist before act):
 *   1. load (or create) the run                      -- DB
 *   2. run the stage handler unless its result is already stored   -- handler's own transactions
 *   3. store the result                              -- DB
 *   4. enqueue the next stage with key {messageId}:{next}  -- Redis, idempotent
 * A crash after 3 and before 4 is repaired by redelivery: step 2 is skipped, step 4 repeats safely.
 */
export function makeStageHandler(stage: QueueStage, deps: RunnerDeps): QueueHandler {
  return async (envelope, ctx: HandlerContext) => {
    const parsed = StagePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new PermanentFailureError("payload must contain a messageId", "invalid_payload");
    const { messageId } = parsed.data;
    const { tenantId, traceId } = envelope;
    const ids = { stage, traceId, tenantId, messageId };
    const db = <T>(fn: (c: Client) => Promise<T>) => withTenant(deps.pool, tenantId, fn);

    const run = await db((c) => loadOrCreateRun(c, tenantId, messageId, traceId));
    if (run.status === "completed") {
      deps.log({ event: "stage_skipped", ...ids, outcome: "run_completed" });
      return;
    }

    let stopReason = run.stop_reason;
    if (stage !== "ingest") {
      const pipelineStage: PipelineStage = stage;
      if (run.stage_results[stage] === undefined) {
        const handler = deps.stages.get(pipelineStage);
        if (!handler) throw new PermanentFailureError("no handler registered for stage", "no_stage_handler");
        const conversationId = await db(async (c) =>
          (await c.query<{ conversation_id: string }>("SELECT conversation_id FROM pipeline_runs WHERE id = $1", [run.id])).rows[0]!.conversation_id);
        const outcome = await withTimeout(deps.stageTimeoutMs, (signal) =>
          handler({ tenantId, conversationId, messageId, traceId, stage: pipelineStage, attempt: ctx.attempt, results: run.stage_results, db, signal }),
        );
        stopReason = outcome.stop ?? null;
        await db((c) =>
          c.query(
            `UPDATE pipeline_runs
             SET current_stage = $2, stage_results = stage_results || jsonb_build_object($2::text, $3::jsonb),
                 stop_reason = $4, status = CASE WHEN $4::text IS NULL THEN status ELSE 'completed' END,
                 updated_at = now()
             WHERE id = $1`,
            [run.id, stage, JSON.stringify(outcome.result), stopReason],
          ),
        );
        deps.log({ event: "stage_done", ...ids, outcome: stopReason ? "stopped" : "ok" });
      } else {
        deps.log({ event: "stage_skipped", ...ids, outcome: "result_stored" });
      }
    }
    if (stopReason) return;

    const next = nextStage(stage);
    if (next) {
      await deps.producer.enqueue(
        { stage: next, tenantId, conversationId: envelope.conversationId, traceId, payload: { messageId } },
        { idempotencyKey: derivedJobKey(messageId, next) },
      );
    } else {
      await db((c) => c.query("UPDATE pipeline_runs SET status = 'completed', updated_at = now() WHERE id = $1", [run.id]));
      deps.log({ event: "run_completed", ...ids, outcome: "ok" });
    }
  };
}
