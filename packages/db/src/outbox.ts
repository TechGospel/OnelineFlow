/**
 * Transactional outbox + relay.
 *
 * The problem it solves: "update the invoice AND enqueue a job" spans Postgres
 * and Redis. There is no distributed transaction, so one of them will eventually
 * happen without the other. Under load that is not hypothetical — it is a
 * weekly occurrence.
 *
 * The fix: only ever write to Postgres. The relay reads committed outbox rows
 * and pushes to Redis. Delivery becomes at-least-once, which is fine because
 * every consumer is idempotent by design.
 */

import type pg from 'pg';
import type { TenantId } from '@onelineflow/core';

export interface OutboxEvent {
  readonly aggregateType: 'invoice' | 'connection' | 'tenant';
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxRecord extends OutboxEvent {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly attempts: number;
}

/** Must be called inside the same transaction as the state change it accompanies. */
export async function enqueueOutbox(
  tx: pg.PoolClient,
  tenantId: TenantId,
  event: OutboxEvent,
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      tenantId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      JSON.stringify(event.payload),
    ],
  );
}

/**
 * Claim a batch for publishing.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets N relay replicas drain the same table
 * concurrently without coordinating: each grabs a disjoint set and no relay
 * ever blocks behind another. Without SKIP LOCKED this degenerates to a single
 * serialised consumer.
 */
export async function claimOutboxBatch(tx: pg.PoolClient, limit: number): Promise<OutboxRecord[]> {
  const { rows } = await tx.query(
    `SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload, attempts
       FROM outbox
      WHERE published_at IS NULL
      ORDER BY created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  /* eslint-disable @typescript-eslint/no-explicit-any -- row mapping boundary */
  return rows.map((r: any) => ({
    id: String(r.id),
    tenantId: r.tenant_id as TenantId,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    payload: r.payload,
    attempts: r.attempts,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export async function markPublished(tx: pg.PoolClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [ids]);
}

export async function markFailed(tx: pg.PoolClient, id: string, error: string): Promise<void> {
  await tx.query(
    `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1::bigint`,
    [id, error.slice(0, 2000)],
  );
}

/**
 * Delete published rows older than the retention window.
 *
 * Bounded by `limit` and run in a loop by the caller: an unbounded DELETE of a
 * day's worth of rows takes a long lock and bloats the table. Small batches keep
 * autovacuum able to keep up.
 */
export async function pruneOutbox(
  client: pg.PoolClient,
  olderThan: Date,
  limit = 5000,
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM outbox WHERE id IN (
       SELECT id FROM outbox
        WHERE published_at IS NOT NULL AND published_at < $1
        ORDER BY id LIMIT $2)`,
    [olderThan, limit],
  );
  return rowCount ?? 0;
}
