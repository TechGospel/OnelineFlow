/**
 * End-to-end smoke test for the outbox relay and document store.
 *
 * Unit tests prove the routing table is right. This proves the pieces actually
 * connect: a committed outbox row becomes a real BullMQ job in real Redis, a
 * redelivery does NOT become a second job, and bytes round-trip through object
 * storage.
 *
 * Run against the compose stack: `pnpm tsx scripts/smoke-relay.ts`
 */

import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { asTenantId, loadConfig, type TenantId } from '@onelineflow/core';
import { Database, enqueueOutbox } from '@onelineflow/db';
import { createLogger } from '@onelineflow/observability';
import { buildConnection, QUEUE_NAMES, QueueRegistry } from '@onelineflow/queue';
import { DocumentStore } from '@onelineflow/storage';
import {
  drainOnce,
  jobId,
  sampleBacklog,
  type RelayDeps,
  type RelayOptions,
} from '../services/relay/src/relay.js';

const cfg = loadConfig();
const logger = createLogger({
  level: 'warn',
  serviceName: 'smoke',
  environment: 'development',
  pretty: true,
});

const db = new Database({
  connectionString: cfg.DATABASE_URL,
  max: 4,
  statementTimeoutMs: 15_000,
  applicationName: 'onelineflow-smoke',
});
const queues = new QueueRegistry(buildConnection(cfg.REDIS_URL), cfg.QUEUE_PREFIX);
const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const documents = new DocumentStore({
  endpoint: cfg.S3_ENDPOINT,
  region: cfg.S3_REGION,
  bucket: cfg.S3_BUCKET_DOCUMENTS,
  accessKeyId: cfg.S3_ACCESS_KEY_ID,
  secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
  forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
});

const deps: RelayDeps = { db, queues, logger };
const opts: RelayOptions = {
  batchSize: 50,
  idlePollMs: 100,
  maxAttempts: 5,
  retentionHours: 72,
};

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const tenantId = asTenantId(randomUUID());
  const invoiceId = randomUUID();

  // Clean slate for the queues this run touches.
  await queues
    .get(QUEUE_NAMES.extraction)
    .obliterate({ force: true })
    .catch(() => {});
  await queues
    .get(QUEUE_NAMES.posting)
    .obliterate({ force: true })
    .catch(() => {});

  /* --- Seed a tenant and an invoice --------------------------------- */
  await db.withBypass('smoke test seed', async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, $2, 'Smoke Test Ltd')`,
      [tenantId, `smoke-${tenantId.slice(0, 8)}`],
    );
    await client.query(`INSERT INTO invoices (id, tenant_id, status) VALUES ($1, $2, 'received')`, [
      invoiceId,
      tenantId,
    ]);
  });

  /* --- 1. Object storage round-trip ---------------------------------- */
  const bytes = Buffer.from('%PDF-1.4\nsmoke test invoice\n');
  const fingerprint = createHash('sha256').update(tenantId).update(' ').update(bytes).digest('hex');

  const stored = await documents.put(tenantId, fingerprint, bytes, 'application/pdf');
  check('document stored', !stored.alreadyExisted, stored.key);

  const fetched = await documents.get(stored.key);
  check('document round-trips byte-identically', fetched.equals(bytes));

  const again = await documents.put(tenantId, fingerprint, bytes, 'application/pdf');
  check('re-storing identical bytes is a no-op', again.alreadyExisted);

  /* --- 2. Outbox → queue --------------------------------------------- */
  await db.withTenant(tenantId, async (client) => {
    await db.transaction(client, async (tx) => {
      await enqueueOutbox(tx, tenantId, {
        aggregateType: 'invoice',
        aggregateId: invoiceId,
        eventType: 'invoice.received',
        payload: {
          documentId: randomUUID(),
          storageKey: stored.key,
          invoiceCreatedAt: new Date().toISOString(),
        },
      });
    });
  });

  const first = await drainOnce(deps, opts);
  check('relay published the event', first.published === 1, JSON.stringify(first));

  const counts = await queues.get(QUEUE_NAMES.extraction).getJobCounts('waiting', 'delayed');
  check('extraction job is queued', (counts['waiting'] ?? 0) === 1, JSON.stringify(counts));

  const job = await queues.get(QUEUE_NAMES.extraction).getJob(jobId('extract', invoiceId));
  check('job carries the tenant id', job?.data.tenantId === tenantId);

  /* --- 3. Nothing is left unpublished -------------------------------- */
  const second = await drainOnce(deps, opts);
  check('second drain finds nothing', second.claimed === 0, JSON.stringify(second));

  /* --- 4. Redelivery must NOT create a second job -------------------- */
  // This is the property that makes at-least-once delivery safe. Simulating a
  // relay crash after enqueue but before the publish commit.
  await db.withBypass('smoke: simulate redelivery', async (client) => {
    await client.query(
      `UPDATE outbox SET published_at = NULL
        WHERE aggregate_id = $1 AND event_type = 'invoice.received'`,
      [invoiceId],
    );
  });

  const replay = await drainOnce(deps, opts);
  check('replayed row is re-published', replay.published === 1);

  const afterReplay = await queues
    .get(QUEUE_NAMES.extraction)
    .getJobCounts('waiting', 'active', 'completed', 'delayed');
  const total = Object.values(afterReplay).reduce<number>((a, b) => a + Number(b), 0);
  check(
    'redelivery produced NO duplicate job',
    total === 1,
    `${String(total)} job(s): ${JSON.stringify(afterReplay)}`,
  );

  /* --- 5. Unroutable events are drained, not wedged ------------------ */
  await db.withTenant(tenantId, async (client) => {
    await db.transaction(client, async (tx) => {
      await enqueueOutbox(tx, tenantId, {
        aggregateType: 'invoice',
        aggregateId: invoiceId,
        eventType: 'invoice.posted', // audit-only, deliberately unrouted
        payload: {},
      });
    });
  });
  const audit = await drainOnce(deps, opts);
  check('audit-only event is skipped, not retried', audit.skipped === 1 && audit.failed === 0);

  /* --- 6. Backlog metrics reflect an empty outbox -------------------- */
  await sampleBacklog(deps);
  const backlog = await db.withBypass('smoke: backlog', async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox WHERE published_at IS NULL`,
    );
    return Number(rows[0]?.n ?? -1);
  });
  check('outbox fully drained', backlog === 0, `${backlog} unpublished`);

  /* --- Cleanup -------------------------------------------------------- */
  await db.withBypass('smoke: cleanup', async (client) => {
    await client.query('DELETE FROM outbox WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  });
  await queues
    .get(QUEUE_NAMES.extraction)
    .obliterate({ force: true })
    .catch(() => {});
}

main()
  .then(async () => {
    await queues.close();
    redis.disconnect();
    documents.destroy();
    await db.close();
    process.stdout.write(
      failures === 0 ? '\nALL SMOKE CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`\nSMOKE TEST ERROR: ${String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    await queues.close().catch(() => {});
    redis.disconnect();
    await db.close().catch(() => {});
    process.exit(1);
  });

export type { TenantId };
