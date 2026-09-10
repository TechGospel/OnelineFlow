/**
 * Outbox relay entrypoint.
 *
 * Deliberately the smallest service in the platform: it holds no business logic,
 * only the loop. That matters because it is on the critical path for every
 * invoice, so it should be the thing least likely to need a deploy.
 */

import { createServer } from 'node:http';
import { loadConfig } from '@onelineflow/core';
import { Database } from '@onelineflow/db';
import { createLogger, metricsText, ShutdownManager } from '@onelineflow/observability';
import { buildConnection, QueueRegistry } from '@onelineflow/queue';
import { prune, runRelay, sampleBacklog, type RelayDeps, type RelayOptions } from './relay.js';

const cfg = loadConfig();
const logger = createLogger({
  level: cfg.LOG_LEVEL,
  serviceName: 'relay',
  environment: cfg.NODE_ENV,
  pretty: cfg.NODE_ENV === 'development',
});

const shutdown = new ShutdownManager(logger);
shutdown.install();

const db = new Database({
  connectionString: cfg.DATABASE_URL,
  max: cfg.DB_POOL_MAX,
  statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS,
  applicationName: 'onelineflow-relay',
});

const queues = new QueueRegistry(buildConnection(cfg.REDIS_URL), cfg.QUEUE_PREFIX);
const deps: RelayDeps = { db, queues, logger };

const opts: RelayOptions = {
  batchSize: 200,
  // Fast enough that ingestion-to-extraction latency is imperceptible, slow
  // enough that an idle deployment is not hammering Postgres.
  idlePollMs: 250,
  maxAttempts: 10,
  retentionHours: 72,
};

/* --- Background maintenance -------------------------------------------- */
const backlogTimer = setInterval(() => {
  void sampleBacklog(deps).catch((err: unknown) => logger.warn({ err }, 'backlog sample failed'));
}, 10_000);
backlogTimer.unref();

const pruneTimer = setInterval(() => {
  void prune(deps, opts)
    .then((n) => {
      if (n > 0) logger.info({ pruned: n }, 'outbox retention prune complete');
    })
    .catch((err: unknown) => logger.warn({ err }, 'outbox prune failed'));
}, 60 * 60_000);
pruneTimer.unref();

/* --- Health and metrics -------------------------------------------------- */
const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    void metricsText().then((body) =>
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(body),
    );
    return;
  }
  if (req.url === '/healthz') {
    void db
      .healthy()
      .then((ok) =>
        res
          .writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok })),
      );
    return;
  }
  res.writeHead(404).end();
});
metricsServer.listen(cfg.METRICS_PORT);

/* --- Shutdown ------------------------------------------------------------ */
// Order matters: the loop must stop before the queue and pool close, or an
// in-flight enqueue fails and its row is left unpublished (recoverable, but it
// puts a spurious failure in the log every deploy).
shutdown.register({
  name: 'metrics-server',
  order: 20,
  run: () => new Promise<void>((resolve) => metricsServer.close(() => resolve())),
});
shutdown.register({ name: 'queues', order: 30, run: () => queues.close() });
shutdown.register({ name: 'database', order: 40, run: () => db.close() });

await runRelay(deps, opts, shutdown.signal);
