/**
 * The outbox relay.
 *
 * Postgres is the only thing the API and workers write to. This process is what
 * turns those committed rows into queue jobs. Without it the pipeline is inert:
 * invoices arrive, events accumulate, and nothing ever runs.
 *
 * Correctness contract:
 *
 *   - **At-least-once, never at-most-once.** A row is marked published only
 *     AFTER the enqueue returns. A crash in between re-delivers, which is fine
 *     because every consumer is idempotent on a deterministic job id.
 *   - **Never lose ordering per aggregate** in the common case: rows are claimed
 *     in `created_at` order. Strict global ordering is not promised and is not
 *     needed — consumers reconcile against invoice state, not event order.
 *   - **Horizontally scalable.** `FOR UPDATE SKIP LOCKED` lets N replicas drain
 *     disjoint slices with no coordination and no head-of-line blocking.
 *
 * The failure mode to watch is not backlog size, it is backlog AGE. A relay
 * wedged on one poisoned row shows a flat, small backlog while latency climbs.
 */

import { asInvoiceId, asTenantId, toAppError, type TenantId } from '@onelineflow/core';
import {
  claimOutboxBatch,
  markFailed,
  markPublished,
  pruneOutbox,
  type Database,
  type OutboxRecord,
} from '@onelineflow/db';
import { outboxBacklog, outboxOldestAgeSeconds, type Logger } from '@onelineflow/observability';
import { QUEUE_NAMES, type QueueRegistry } from '@onelineflow/queue';

/**
 * Event → queue routing.
 *
 * An event with no route is not an error: several events exist purely for the
 * audit trail and notifications. They are marked published and dropped.
 */
type Router = (
  queues: QueueRegistry,
  tenantId: TenantId,
  aggregateId: string,
  payload: Record<string, unknown>,
) => Promise<void>;

/**
 * Build a BullMQ custom job id.
 *
 * BullMQ forbids ':' in a custom id — it delimits Redis keys with one — and
 * enforces it by throwing at enqueue time. Centralising construction here means
 * one place to get it right, and the test below guards the constraint.
 */
export function jobId(prefix: string, ...parts: (string | number)[]): string {
  const id = [prefix, ...parts.map(String)].join('-');
  if (id.includes(':')) {
    throw new Error(`BullMQ job id must not contain ':' — got "${id}"`);
  }
  return id;
}

const ROUTES: Readonly<Record<string, Router>> = {
  'invoice.received': async (queues, tenantId, invoiceId, payload) => {
    await queues.add(
      QUEUE_NAMES.extraction,
      // Deterministic job id. A row relayed twice produces ONE job, which is
      // what makes at-least-once delivery safe rather than merely tolerable.
      //
      // Separator is '-', not ':'. BullMQ rejects a custom id containing a
      // colon because it uses one internally as a Redis key delimiter, and it
      // throws at enqueue time — which would silently stall the whole pipeline.
      jobId('extract', invoiceId),
      {
        tenantId,
        invoiceId: asInvoiceId(invoiceId),
        documentId: str(payload['documentId']),
        invoiceCreatedAt: str(payload['invoiceCreatedAt'], new Date().toISOString()),
      },
    );
  },

  'invoice.approved': async (queues, tenantId, invoiceId, payload) => {
    await queues.add(
      QUEUE_NAMES.posting,
      // Includes the version so a re-approval after a rejection enqueues a
      // genuinely new job rather than colliding with the settled one.
      jobId('post', invoiceId, num(payload['expectedVersion'])),
      {
        tenantId,
        invoiceId: asInvoiceId(invoiceId),
        invoiceCreatedAt: str(payload['invoiceCreatedAt'], new Date().toISOString()),
        realmId: str(payload['realmId']),
        expectedVersion: num(payload['expectedVersion']),
      },
    );
  },

  'invoice.needs_review': async (queues, tenantId, invoiceId, payload) => {
    await queues.add(QUEUE_NAMES.notification, jobId('notify-review', invoiceId), {
      tenantId,
      kind: 'invoice.needs_review',
      payload: { invoiceId, ...payload },
    });
  },

  'invoice.posting_failed': async (queues, tenantId, invoiceId, payload) => {
    await queues.add(QUEUE_NAMES.notification, jobId('notify-failed', invoiceId), {
      tenantId,
      kind: 'invoice.posting_failed',
      payload: { invoiceId, ...payload },
    });
  },
};

/** Events we deliberately do not route. Listed so an unknown one is visible. */
const AUDIT_ONLY = new Set(['invoice.pending_approval', 'invoice.posted', 'invoice.rejected']);

export interface RelayOptions {
  readonly batchSize: number;
  readonly idlePollMs: number;
  /** Give up on a row after this many attempts and leave it for an operator. */
  readonly maxAttempts: number;
  readonly retentionHours: number;
}

export interface RelayDeps {
  readonly db: Database;
  readonly queues: QueueRegistry;
  readonly logger: Logger;
}

export interface DrainResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Drain one batch.
 *
 * The whole batch runs inside a single transaction holding the row locks. That
 * bounds how long a crashed relay's rows stay invisible to its peers: the locks
 * die with the connection and another replica picks them up immediately.
 */
export async function drainOnce(deps: RelayDeps, opts: RelayOptions): Promise<DrainResult> {
  return deps.db.withBypass('outbox relay drains all tenants', async (client) =>
    deps.db.transaction(client, async (tx) => {
      const batch = await claimOutboxBatch(tx, opts.batchSize);
      if (batch.length === 0) {
        return { claimed: 0, published: 0, failed: 0, skipped: 0 };
      }

      const publishedIds: string[] = [];
      let failed = 0;
      let skipped = 0;

      for (const row of batch) {
        const outcome = await publishOne(deps, opts, row);
        if (outcome === 'published') publishedIds.push(row.id);
        else if (outcome === 'skipped') {
          publishedIds.push(row.id);
          skipped += 1;
        } else {
          failed += 1;
          await markFailed(tx, row.id, outcome.error);
        }
      }

      await markPublished(tx, publishedIds);

      return {
        claimed: batch.length,
        published: publishedIds.length - skipped,
        failed,
        skipped,
      };
    }),
  );
}

async function publishOne(
  deps: RelayDeps,
  opts: RelayOptions,
  row: OutboxRecord,
): Promise<'published' | 'skipped' | { error: string }> {
  const route = ROUTES[row.eventType];

  if (!route) {
    if (AUDIT_ONLY.has(row.eventType)) return 'skipped';
    // An unrouted, unlisted event is a bug — someone added an event type and
    // forgot the route. Log loudly, but do not wedge the queue over it.
    deps.logger.warn(
      { eventType: row.eventType, aggregateId: row.aggregateId },
      'no route for outbox event; dropping',
    );
    return 'skipped';
  }

  if (row.attempts >= opts.maxAttempts) {
    // Leave it unpublished so it stays visible in the backlog metrics and an
    // operator can see it. Do not keep retrying a poisoned row forever.
    deps.logger.error(
      { eventType: row.eventType, aggregateId: row.aggregateId, attempts: row.attempts },
      'outbox row exceeded max attempts; parking for manual intervention',
    );
    return { error: `exceeded ${opts.maxAttempts} attempts` };
  }

  try {
    await route(deps.queues, asTenantId(row.tenantId), row.aggregateId, row.payload);
    return 'published';
  } catch (err) {
    const appErr = toAppError(err);
    deps.logger.warn(
      { err: appErr, eventType: row.eventType, aggregateId: row.aggregateId },
      'failed to enqueue outbox event',
    );
    return { error: appErr.message };
  }
}

/**
 * Publish backlog metrics.
 *
 * `oldest_age_seconds` is the alert that matters. Backlog count alone is
 * misleading: a relay stuck on a single poisoned row shows a small, stable count
 * while end-to-end latency grows without bound.
 */
export async function sampleBacklog(deps: RelayDeps): Promise<void> {
  await deps.db.withBypass('outbox backlog metrics', async (client) => {
    const { rows } = await client.query<{ n: string; oldest_age: string | null }>(
      `SELECT count(*)::text AS n,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::text AS oldest_age
         FROM outbox WHERE published_at IS NULL`,
    );
    const row = rows[0];
    outboxBacklog.set(Number(row?.n ?? 0));
    outboxOldestAgeSeconds.set(Number(row?.oldest_age ?? 0));
  });
}

/** Delete published rows past retention, in bounded batches. */
export async function prune(deps: RelayDeps, opts: RelayOptions): Promise<number> {
  const cutoff = new Date(Date.now() - opts.retentionHours * 3_600_000);
  return deps.db.withBypass('outbox retention prune', async (client) => {
    let total = 0;
    // Small batches in a loop: one unbounded DELETE of a day's rows takes a long
    // lock and leaves bloat autovacuum struggles to reclaim.
    for (;;) {
      const n = await pruneOutbox(client, cutoff, 5_000);
      total += n;
      if (n < 5_000) break;
    }
    return total;
  });
}

/**
 * The relay loop.
 *
 * Drains continuously while there is work, then backs off to a poll interval
 * when idle. It does NOT use LISTEN/NOTIFY: notifications are lost if no
 * listener is connected at the moment of the notify, so a relay restart would
 * silently skip whatever arrived during the gap. Polling cannot miss a row.
 */
export async function runRelay(
  deps: RelayDeps,
  opts: RelayOptions,
  signal: AbortSignal,
): Promise<void> {
  deps.logger.info({ batchSize: opts.batchSize }, 'outbox relay started');

  while (!signal.aborted) {
    let result: DrainResult;
    try {
      result = await drainOnce(deps, opts);
    } catch (err) {
      deps.logger.error({ err }, 'relay drain failed; backing off');
      await sleep(opts.idlePollMs, signal);
      continue;
    }

    if (result.claimed > 0) {
      deps.logger.debug(result, 'relay batch drained');
    }

    // Only sleep when the batch came back short. A full batch means there is
    // almost certainly more waiting, and sleeping would add latency for nothing.
    if (result.claimed < opts.batchSize) {
      await sleep(opts.idlePollMs, signal);
    }
  }

  deps.logger.info('outbox relay stopped');
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Narrow a jsonb payload value to a string.
 *
 * Payload values arrive as `unknown`. Calling String() on one would turn an
 * object into the literal "[object Object]" and put that in a job payload,
 * where it would fail much later and much less obviously.
 */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export { ROUTES, AUDIT_ONLY, str as coerceString, num as coerceNumber };
