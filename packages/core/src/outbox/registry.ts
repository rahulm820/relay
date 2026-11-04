import type { OutboxKind } from "@relay/shared";

export interface OutboxHandlerInput {
  outboxId: string;
  tenantId: string;
  kind: OutboxKind;
  /** Pass this to the external system (GitHub, Switch, ...) so a retry cannot repeat the effect. */
  idempotencyKey: string;
  /** The row's payload; includes `traceId`. */
  payload: Record<string, unknown>;
  /** 1-based; counts earlier attempts that crashed or failed. */
  attempt: number;
  traceId: string | undefined;
}

/**
 * Performs the external side effect. Delivery is at least once, so it must tolerate repeats (use the
 * idempotency key). Throw to retry with backoff; throw PermanentFailureError to fail the row for good.
 * A returned `note` is stored on the finished row (used by the no-op skeletons).
 * Error messages are stored on the row: never put message text or secrets in them.
 */
export type OutboxHandler = (input: OutboxHandlerInput) => Promise<void | { note?: string }>;

export class OutboxRegistry {
  private readonly handlers = new Map<OutboxKind, OutboxHandler>();

  register(kind: OutboxKind, handler: OutboxHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  get(kind: OutboxKind): OutboxHandler | undefined {
    return this.handlers.get(kind);
  }
}
