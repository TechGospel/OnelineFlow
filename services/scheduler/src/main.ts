/**
 * Maintenance scheduler.
 *
 * A single-replica service by design. Every task is idempotent, so a second
 * replica would be harmless but pointless; running one and alerting when it
 * stops is simpler than coordinating leader election for work that takes
 * milliseconds.
 *
 * It runs a sweep at boot — a deploy should not leave a gap — then hourly.
 */

import { createServer } from 'node:http';
import { loadConfig } from '@onelineflow/core';
import { ConnectionRepository, Database } from '@onelineflow/db';
import { EnvKeyring } from '@onelineflow/crypto';
import {
  createLogger,
  metricsText,
  schedulerLastSweep,
  ShutdownManager,
} from '@onelineflow/observability';
import { DEFAULT_MAINTENANCE, runMaintenance } from './tasks.js';

const cfg = loadConfig();
const logger = createLogger({
  level: cfg.LOG_LEVEL,
  serviceName: 'scheduler',
  environment: cfg.NODE_ENV,
  pretty: cfg.NODE_ENV === 'development',
});

const shutdown = new ShutdownManager(logger);
shutdown.install();

const db = new Database({
  connectionString: cfg.DATABASE_URL,
  max: 4,
  statementTimeoutMs: 60_000,
  applicationName: 'onelineflow-scheduler',
});

const connections = new ConnectionRepository(
  new EnvKeyring(cfg.ENCRYPTION_ROOT_KEY, cfg.ENCRYPTION_KEY_VERSION),
);

/** Timestamp of the last successful sweep, exposed for a staleness alert. */
let lastSweepAt: Date | null = null;
let lastResults: unknown[] = [];

async function sweep(): Promise<void> {
  try {
    lastResults = await runMaintenance(db, connections, logger, DEFAULT_MAINTENANCE);
    lastSweepAt = new Date();
    schedulerLastSweep.set(Math.floor(lastSweepAt.getTime() / 1000));
  } catch (err) {
    logger.error({ err }, 'maintenance sweep failed entirely');
  }
}

const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    void metricsText().then((body) =>
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(body),
    );
    return;
  }
  if (req.url === '/healthz') {
    // Unhealthy if no sweep has landed in three hours. A scheduler that is
    // running but not sweeping is indistinguishable from a healthy one unless
    // the health check actually asserts progress.
    const stale = lastSweepAt !== null && Date.now() - lastSweepAt.getTime() > 3 * 60 * 60_000;
    const ok = lastSweepAt !== null && !stale;
    res
      .writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok, lastSweepAt, results: lastResults }));
    return;
  }
  res.writeHead(404).end();
});
metricsServer.listen(cfg.METRICS_PORT);

// Sweep immediately so a deploy closes any gap, then hourly.
await sweep();

const timer = setInterval(() => void sweep(), 60 * 60_000);
timer.unref();

shutdown.register({
  name: 'metrics-server',
  order: 20,
  run: () => new Promise<void>((resolve) => metricsServer.close(() => resolve())),
});
shutdown.register({ name: 'database', order: 40, run: () => db.close() });

logger.info({ intervalMinutes: 60 }, 'scheduler started');
