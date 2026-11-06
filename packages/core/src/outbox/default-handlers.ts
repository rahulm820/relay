import { OUTBOX_KINDS, type OutboxKind } from "@relay/shared";
import { OutboxRegistry, type OutboxHandler } from "./registry.js";

export const NOOP_NOTE = "noop handler (skeleton): no side effect performed";

/**
 * Skeleton: completes the row without doing anything and says so on the row and in the log.
 * Chosen over leaving kinds unregistered so skeleton-phase rows do not retry forever; each later issue
 * registers the real handler: github.create_issue #12, github.draft #13, switch.create_room #15,
 * client.send #16.
 */
const noop = (kind: OutboxKind, log: (e: object) => void): OutboxHandler => async (input) => {
  log({ event: "outbox_noop", kind, outboxId: input.outboxId, tenantId: input.tenantId, traceId: input.traceId });
  return { note: NOOP_NOTE };
};

export function createDefaultOutboxRegistry(log: (e: object) => void = (e) => console.log(JSON.stringify(e))): OutboxRegistry {
  const registry = new OutboxRegistry();
  for (const kind of OUTBOX_KINDS) registry.register(kind, noop(kind, log));
  return registry;
}
