/**
 * Posting worker entrypoint.
 *
 * Wires the dependency graph, installs graceful shutdown, and runs the BullMQ
 * consumer. The job handler is thin on purpose: all the interesting logic lives
 * in post-invoice.ts where it can be unit-tested without Redis.
 */

import { Redis } from 'ioredis';
import { asInvoiceId, asRealmId, asTenantId, loadConfig, toAppError } from '@onelineflow/core';
import { ConnectionRepository, Database, InvoiceRepository } from '@onelineflow/db';
import { EnvKeyring } from '@onelineflow/crypto';
import { QboClient, QboRateLimiter, ReferenceResolver, type AuditSink } from '@onelineflow/qbo';
import {
  createLogger,
  metricsText,
  queueDepth,
  ShutdownManager,
  withContext,
} from '@onelineflow/observability';
import {
  buildConnection,
  QUEUE_NAMES,
  QueueRegistry,
  TenantFairGate,
  Worker,
  type PostingJob,
} from '@onelineflow/queue';
import { createServer } from 'node:http';
import { postInvoice } from './post-invoice.js';

const cfg = loadConfig();
const logger = createLogger({
  level: cfg.LOG_LEVEL,
  serviceName: 'worker-posting',
  environment: cfg.NODE_ENV,
  pretty: cfg.NODE_ENV === 'development',
});

const shutdown = new ShutdownManager(logger);
shutdown.install();

const db = new Database({
  connectionString: cfg.DATABASE_URL,
  max: cfg.DB_POOL_MAX,
  statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS,
  applicationName: 'onelineflow-worker-posting',
});

const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const keyring = new EnvKeyring(cfg.ENCRYPTION_ROOT_KEY, cfg.ENCRYPTION_KEY_VERSION);
const connections = new ConnectionRepository(keyring);
const invoices = new InvoiceRepository();

/** Writes the QBO call audit row. Best-effort by contract. */
const auditSink: AuditSink = {
  async record(entry) {
    await db
      .withTenant(entry.tenantId, async (client) => {
        await client.query(
          `INSERT INTO qbo_api_calls
             (tenant_id, realm_id, invoice_id, method, path, request_id, http_status,
              intuit_tid, fault_code, duration_ms, attempt, request_body, response_body)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)`,
          [
            entry.tenantId,
            entry.realmId,
            entry.invoiceId ?? null,
            entry.method,
            entry.path,
            entry.requestId ?? null,
            entry.httpStatus,
            entry.intuitTid,
            entry.faultCode,
            entry.durationMs,
            entry.attempt,
            JSON.stringify(entry.requestBody ?? null),
            JSON.stringify(entry.responseBody ?? null),
          ],
        );
      })
      .catch((err: unknown) => logger.warn({ err }, 'failed to write qbo audit row'));
  },
};

const limiter = new QboRateLimiter(redis, {
  requestsPerMinute: cfg.QBO_RATE_LIMIT_PER_MIN,
  maxConcurrent: cfg.QBO_MAX_CONCURRENT_PER_REALM,
  leaseMs: cfg.QBO_REQUEST_TIMEOUT_MS * 2,
  keyPrefix: cfg.QUEUE_PREFIX,
});

const qbo = new QboClient(
  {
    environment: cfg.QBO_ENVIRONMENT,
    minorVersion: cfg.QBO_MINOR_VERSION,
    timeoutMs: cfg.QBO_REQUEST_TIMEOUT_MS,
    oauth: {
      clientId: cfg.QBO_CLIENT_ID,
      clientSecret: cfg.QBO_CLIENT_SECRET,
      redirectUri: cfg.QBO_REDIRECT_URI,
      timeoutMs: cfg.QBO_REQUEST_TIMEOUT_MS,
    },
  },
  limiter,
  connections,
  auditSink,
);

const references = new ReferenceResolver(qbo);
const queues = new QueueRegistry(buildConnection(cfg.REDIS_URL), cfg.QUEUE_PREFIX);
const fairGate = new TenantFairGate(redis, {
  keyPrefix: cfg.QUEUE_PREFIX,
  defaultLimit: cfg.QBO_MAX_CONCURRENT_PER_REALM,
  leaseMs: cfg.QBO_REQUEST_TIMEOUT_MS * 3,
});

const worker = new Worker<PostingJob>(
  QUEUE_NAMES.posting,
  async (job) => {
    const tenantId = asTenantId(job.data.tenantId);
    const invoiceId = asInvoiceId(job.data.invoiceId);

    // Fairness: if this tenant already has its share of postings in flight,
    // defer rather than occupying a worker slot that another tenant could use.
    const slot = await fairGate.acquire(QUEUE_NAMES.posting, tenantId);
    if (!slot.acquired) {
      await job.moveToDelayed(Date.now() + 2_000 + Math.floor(Math.random() * 3_000));
      return { deferred: true };
    }

    try {
      return await withContext(
        { requestId: job.id ?? 'unknown', tenantId, invoiceId, jobId: job.id ?? '' },
        () =>
          postInvoice(
            { db, invoices, connections, qbo, references, logger },
            {
              tenantId,
              invoiceId,
              invoiceCreatedAt: new Date(job.data.invoiceCreatedAt),
              realmId: asRealmId(job.data.realmId),
              signal: shutdown.signal,
            },
          ),
      );
    } catch (err) {
      const appErr = toAppError(err);
      // Non-retryable failures are already parked in the database. Telling
      // BullMQ to retry them would just burn attempts on a settled outcome.
      if (!appErr.retryable) {
        logger.warn({ err: appErr, invoiceId }, 'permanent failure; not retrying');
        return { parked: true, reason: appErr.message };
      }
      throw appErr;
    } finally {
      await slot.release();
    }
  },
  {
    connection: buildConnection(cfg.REDIS_URL),
    prefix: cfg.QUEUE_PREFIX,
    concurrency: cfg.WORKER_CONCURRENCY,
    // Must exceed the QBO timeout, or BullMQ reclaims a job that is still
    // mid-post and a second worker starts it — the duplicate scenario.
    lockDuration: cfg.QBO_REQUEST_TIMEOUT_MS * 3,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
);

worker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, invoiceId: job?.data.invoiceId, attempts: job?.attemptsMade, err },
    'posting job failed',
  );
});
worker.on('error', (err) => logger.error({ err }, 'worker error'));

/* --- Metrics + health endpoint ---------------------------------------- */
const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    void metricsText().then((body) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(body);
    });
    return;
  }
  if (req.url === '/healthz') {
    void db.healthy().then((ok) => {
      res
        .writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok, pool: db.stats }));
    });
    return;
  }
  res.writeHead(404).end();
});
metricsServer.listen(cfg.METRICS_PORT);

/**
 * Publish queue depth for alerting. Read through a Queue handle rather than the
 * Worker — a Worker only knows about the jobs it is running, so it cannot see a
 * backlog, which is the number that actually matters.
 */
const depthQueue = queues.get(QUEUE_NAMES.posting);
const depthTimer = setInterval(() => {
  void depthQueue
    .getJobCounts('waiting', 'active', 'delayed', 'failed')
    .then((counts) => {
      for (const [state, count] of Object.entries(counts)) {
        queueDepth.set({ queue: QUEUE_NAMES.posting, state }, count);
      }
    })
    .catch((err: unknown) => logger.debug({ err }, 'queue depth sample failed'));
}, 15_000);
depthTimer.unref();

/* --- Shutdown ordering -------------------------------------------------- */
shutdown.register({
  name: 'stop-accepting-jobs',
  order: 10,
  run: async () => {
    // `false` = do not force. Let in-flight posts finish; a killed post is the
    // expensive case because its outcome becomes unknown.
    await worker.close(false);
  },
});
shutdown.register({
  name: 'metrics-server',
  order: 20,
  run: async () => new Promise<void>((resolve) => metricsServer.close(() => resolve())),
});
shutdown.register({ name: 'queues', order: 25, run: () => queues.close() });
shutdown.register({ name: 'redis', order: 30, run: () => Promise.resolve(redis.disconnect()) });
shutdown.register({ name: 'database', order: 40, run: () => db.close() });

logger.info(
  { concurrency: cfg.WORKER_CONCURRENCY, env: cfg.QBO_ENVIRONMENT },
  'posting worker started',
);
