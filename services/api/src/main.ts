/**
 * HTTP API.
 *
 * Responsibilities kept deliberately narrow: authenticate, validate, write to
 * Postgres (including the outbox), return. No QBO calls, no AI calls, no long
 * work on the request path. Everything slow is a queue job.
 *
 * That separation is what lets the API run at a few hundred milliseconds p99
 * while extraction takes ten seconds.
 */

import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { loadConfig, toAppError } from '@onelineflow/core';
import { ConnectionRepository, Database, InvoiceRepository } from '@onelineflow/db';
import { EnvKeyring } from '@onelineflow/crypto';
import { createLogger, metricsText, ShutdownManager } from '@onelineflow/observability';
import { buildConnection, QueueRegistry } from '@onelineflow/queue';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

const cfg = loadConfig();
const logger = createLogger({
  level: cfg.LOG_LEVEL,
  serviceName: 'api',
  environment: cfg.NODE_ENV,
  pretty: cfg.NODE_ENV === 'development',
});

const shutdown = new ShutdownManager(logger);
shutdown.install();

const db = new Database({
  connectionString: cfg.DATABASE_URL,
  max: cfg.DB_POOL_MAX,
  statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS,
  applicationName: 'onelineflow-api',
});
const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const queues = new QueueRegistry(buildConnection(cfg.REDIS_URL), cfg.QUEUE_PREFIX);
const keyring = new EnvKeyring(cfg.ENCRYPTION_ROOT_KEY, cfg.ENCRYPTION_KEY_VERSION);

const app = Fastify({
  // Fastify 5 takes a pre-built logger as `loggerInstance`; `logger` is for
  // options it should construct itself. Passing ours keeps the redaction
  // config and async-local context binding.
  loggerInstance: logger,
  bodyLimit: cfg.HTTP_BODY_LIMIT_BYTES,
  // Trust only the immediate hop when reading X-Forwarded-For. Trusting the
  // whole chain lets any caller spoof their own client IP by prepending an
  // address, which would poison rate limiting and audit records alike.
  trustProxy: (_address: string, hop: number) => hop === 0,
  requestIdHeader: 'x-request-id',
  genReqId: () => randomUUID(),
  disableRequestLogging: false,
});

const deps = {
  cfg,
  db,
  redis,
  queues,
  logger,
  invoices: new InvoiceRepository(),
  connections: new ConnectionRepository(keyring),
};

export type ApiDeps = typeof deps;

/**
 * Uniform error shape. Internal detail never crosses the boundary: `message` is
 * always the curated publicMessage, with the full error in the logs under the
 * same requestId so support can join them.
 */
app.setErrorHandler((err, req, reply) => {
  const appErr = toAppError(err);
  const status = 'httpStatus' in appErr ? appErr.httpStatus : 500;

  if (status >= 500) {
    req.log.error({ err: appErr, context: appErr.context }, 'request failed');
  } else {
    req.log.warn({ err: appErr.message, category: appErr.category }, 'request rejected');
  }

  void reply.status(status).send({
    error: {
      category: appErr.category,
      message: appErr.publicMessage,
      ...(appErr.field !== undefined ? { field: appErr.field } : {}),
      requestId: req.id,
    },
  });
});

app.get('/healthz', async (_req, reply) => {
  const ok = await db.healthy();
  return reply.status(ok ? 200 : 503).send({ ok, pool: db.stats });
});

/**
 * Readiness is stricter than liveness: it also requires Redis, because a pod
 * that cannot enqueue would accept invoices and silently drop them.
 */
app.get('/readyz', async (_req, reply) => {
  const [dbOk, redisOk] = await Promise.all([
    db.healthy(),
    redis
      .ping()
      .then(() => true)
      .catch(() => false),
  ]);
  const ok = dbOk && redisOk;
  return reply.status(ok ? 200 : 503).send({ ok, db: dbOk, redis: redisOk });
});

app.get('/metrics', async (_req, reply) =>
  reply.header('Content-Type', 'text/plain; version=0.0.4').send(await metricsText()),
);

registerOAuthRoutes(app, deps);
registerIngestRoutes(app, deps);
registerWebhookRoutes(app, deps);

shutdown.register({
  name: 'http-server',
  order: 10,
  // Fastify stops accepting new connections and drains keep-alives.
  run: () => app.close(),
});
shutdown.register({ name: 'queues', order: 20, run: () => queues.close() });
shutdown.register({ name: 'redis', order: 30, run: () => Promise.resolve(redis.disconnect()) });
shutdown.register({ name: 'database', order: 40, run: () => db.close() });

await app.listen({ port: cfg.HTTP_PORT, host: cfg.HTTP_HOST });
logger.info({ port: cfg.HTTP_PORT }, 'api listening');
