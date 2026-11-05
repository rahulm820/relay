import type { Client } from "@relay/db";
import { OutboxJobSchema, type OutboxJob } from "@relay/shared";
import { PermanentFailureError } from "../queue/index.js";

/**
 * Adds an outbox row. Call it with the client of the SAME transaction as the domain write it belongs to
 * (transactional outbox), so either both commit or neither does. The unique idempotency_key makes a
 * repeat a no-op: it returns the existing row with `inserted: false`.
 * The trace id is stored in the payload as `traceId`.
 */
export async function enqueueOutbox(client: Client, job: OutboxJob): Promise<{ id: string; inserted: boolean }> {
  const j = OutboxJobSchema.parse(job);
  const payload = { ...j.payload, traceId: j.traceId };
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO outbox (tenant_id, kind, payload, idempotency_key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [j.tenantId, j.kind, JSON.stringify(payload), j.idempotencyKey],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, inserted: true };
  const existing = await client.query<{ id: string }>("SELECT id FROM outbox WHERE idempotency_key = $1", [j.idempotencyKey]);
  // Not visible under this tenant's RLS: the key belongs to someone else.
  if (!existing.rows[0]) throw new PermanentFailureError("idempotency key already used", "idempotency_key_conflict");
  return { id: existing.rows[0].id, inserted: false };
}
