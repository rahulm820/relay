import type { Pool } from "@relay/db";
import { QUEUE_STAGES } from "@relay/shared";
import type { Redis } from "ioredis";
import { QueueConsumer, QueueProducer, type ConsumerOptions, type QueueLogEvent } from "../queue/index.js";
import { makeStageHandler, type OrchestratorLogEvent } from "./runner.js";
import type { StageRegistry } from "./stages.js";

export interface OrchestratorOptions {
  pool: Pool;
  redis: Redis;
  stages: StageRegistry;
  /** Per-stage handler timeout; must stay below the consumer's minIdleMs minus its retry budget. */
  stageTimeoutMs?: number;
  /** Overrides for every stage consumer (retry counts, block time, ...). `stage` and `handler` are fixed. */
  consumer?: Partial<Omit<ConsumerOptions, "stage" | "handler">>;
  log?: (event: OrchestratorLogEvent | QueueLogEvent) => void;
}

/**
 * Starts exactly one consumer per queue stage. Ordering is only guaranteed per consumer
 * (see QueueConsumer), so do not run a second Orchestrator against the same Redis.
 */
export class Orchestrator {
  private readonly consumers: QueueConsumer[] = [];
  private readonly producer: QueueProducer;

  constructor(private readonly opts: OrchestratorOptions) {
    this.producer = new QueueProducer(opts.redis);
  }

  async start(): Promise<void> {
    const log = this.opts.log ?? ((e) => console.log(JSON.stringify(e)));
    for (const stage of QUEUE_STAGES) {
      const handler = makeStageHandler(stage, {
        pool: this.opts.pool, producer: this.producer, stages: this.opts.stages,
        stageTimeoutMs: this.opts.stageTimeoutMs ?? 30_000, log,
      });
      const consumer = new QueueConsumer(this.opts.redis, { ...this.opts.consumer, stage, handler, log });
      this.consumers.push(consumer);
      await consumer.start();
    }
  }

  /** Stops reading and waits for in-flight stages to finish. Does not close the pool or Redis. */
  async close(): Promise<void> {
    await Promise.all(this.consumers.map((c) => c.close()));
  }
}
