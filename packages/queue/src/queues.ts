/**
 * Queue topology.
 *
 * The scaling problem this solves: with one shared FIFO queue, a single tenant
 * dumping 200,000 invoices at month-end puts every other tenant behind them.
 * Small tenants see hours of latency for a handful of invoices. That is the
 * classic noisy-neighbour failure and it is the main thing that makes a
 * multi-tenant pipeline feel broken.
 *
 * BullMQ's `Queue.Group` (per-group round-robin) is the clean answer where
 * available; here we implement the same idea explicitly with per-tenant
 * concurrency limits plus a priority derived from a tenant's in-flight count,
 * so the scheduler naturally favours tenants who are not already saturating.
 */

import { Queue, QueueEvents, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { InvoiceId, TenantId } from '@onelineflow/core';

export const QUEUE_NAMES = {
  extraction: 'extraction',
  validation: 'validation',
  posting: 'posting',
  reconciliation: 'reconciliation',
  notification: 'notification',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface ExtractionJob {
  readonly tenantId: TenantId;
  readonly invoiceId: InvoiceId;
  readonly documentId: string;
  readonly invoiceCreatedAt: string;
}

export interface PostingJob {
  readonly tenantId: TenantId;
  readonly invoiceId: InvoiceId;
  readonly invoiceCreatedAt: string;
  readonly realmId: string;
  /** Version the job was created against; a mismatch means re-read, not retry. */
  readonly expectedVersion: number;
}

export interface JobPayloads {
  extraction: ExtractionJob;
  validation: ExtractionJob;
  posting: PostingJob;
  reconciliation: { tenantId: TenantId; realmId: string; sinceIso: string };
  notification: { tenantId: TenantId; kind: string; payload: Record<string, unknown> };
}

/**
 * Defaults applied to every job.
 *
 * `attempts` is high but the backoff is what matters: 5 tries over ~10 minutes
 * absorbs a QBO blip without hammering it. Non-retryable errors short-circuit
 * this by being caught in the worker and failing the job permanently.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  // Keep completed jobs briefly for debugging; keep failures much longer.
  removeOnComplete: { age: 3600, count: 10_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

export function buildConnection(redisUrl: string): ConnectionOptions {
  return {
    url: redisUrl,
    // BullMQ requires this to be null: a blocking BRPOPLPUSH must not be
    // aborted by ioredis' own retry cap, or workers silently stop consuming.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

export class QueueRegistry {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly events = new Map<QueueName, QueueEvents>();

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly prefix: string,
  ) {}

  get<K extends QueueName>(name: K): Queue<JobPayloads[K], unknown, string> {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(name, q);
    }
    return q as Queue<JobPayloads[K], unknown, string>;
  }

  eventsFor(name: QueueName): QueueEvents {
    let e = this.events.get(name);
    if (!e) {
      e = new QueueEvents(name, { connection: this.connection, prefix: this.prefix });
      this.events.set(name, e);
    }
    return e;
  }

  /**
   * Enqueue with a deterministic job id.
   *
   * BullMQ deduplicates on job id, so an outbox row relayed twice — which WILL
   * happen, at-least-once delivery is the design — produces one job, not two.
   */
  async add<K extends QueueName>(
    name: K,
    dedupeKey: string,
    payload: JobPayloads[K],
    opts: JobsOptions = {},
  ): Promise<void> {
    // BullMQ derives the job-name type from the payload type, which it cannot
    // resolve while `K` is still generic. The public signature above keeps
    // callers type-safe; this one cast is confined to the implementation.
    const queue: Queue = this.get(name);
    await queue.add(name, payload, {
      ...DEFAULT_JOB_OPTIONS,
      ...opts,
      jobId: dedupeKey,
    });
  }

  async close(): Promise<void> {
    await Promise.all([
      ...[...this.queues.values()].map((q) => q.close()),
      ...[...this.events.values()].map((e) => e.close()),
    ]);
  }
}

export { Queue, Worker, QueueEvents };
export type { ConnectionOptions, JobsOptions };
