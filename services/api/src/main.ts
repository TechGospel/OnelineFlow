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
import formbody from '@fastify/formbody';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { loadConfig, toAppError } from '@onelineflow/core';
import { ConnectionRepository, Database, InvoiceRepository } from '@onelineflow/db';
import { EnvKeyring } from '@onelineflow/crypto';
import { createLogger, metricsText, ShutdownManager } from '@onelineflow/observability';
import { buildConnection, QueueRegistry } from '@onelineflow/queue';
import { DocumentStore } from '@onelineflow/storage';
import { QboClient, QboRateLimiter, type AuditSink } from '@onelineflow/qbo';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerInvoiceRoutes } from './routes/invoices.js';
import { registerVendorRoutes } from './routes/vendors.js';
import { registerReviewUiRoutes } from './routes/review-ui.js';
import { jwtAuthPlugin } from './plugins/jwt-auth.js';

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
const documents = new DocumentStore({
  endpoint: cfg.S3_ENDPOINT,
  region: cfg.S3_REGION,
  bucket: cfg.S3_BUCKET_DOCUMENTS,
  accessKeyId: cfg.S3_ACCESS_KEY_ID,
  secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
  forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
  serverSideEncryption: cfg.S3_SERVER_SIDE_ENCRYPTION,
});

/**
 * QuickBooks client for the vendor routes.
 *
 * The API makes only small, interactive QBO calls (look up a vendor, create
 * one). It shares the same per-realm rate limiter as the workers, so an
 * interactive burst still cannot crowd out posting.
 */
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

const connectionRepository = new ConnectionRepository(keyring);

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
  new QboRateLimiter(redis, {
    requestsPerMinute: cfg.QBO_RATE_LIMIT_PER_MIN,
    maxConcurrent: cfg.QBO_MAX_CONCURRENT_PER_REALM,
    leaseMs: cfg.QBO_REQUEST_TIMEOUT_MS * 2,
    keyPrefix: cfg.QUEUE_PREFIX,
  }),
  connectionRepository,
  auditSink,
);

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
  connections: connectionRepository,
  documents,
  qbo,
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
  // Object storage is included deliberately: a pod that cannot write documents
  // would accept invoices and lose the bytes, which is worse than refusing them.
  const [dbOk, redisOk, storageOk] = await Promise.all([
    db.healthy(),
    redis
      .ping()
      .then(() => true)
      .catch(() => false),
    documents.healthy(),
  ]);
  const ok = dbOk && redisOk && storageOk;
  return reply.status(ok ? 200 : 503).send({ ok, db: dbOk, redis: redisOk, storage: storageOk });
});

app.get('/metrics', async (_req, reply) =>
  reply.header('Content-Type', 'text/plain; version=0.0.4').send(await metricsText()),
);

// The review UI degrades to plain HTML forms with no JavaScript, so the API
// must accept application/x-www-form-urlencoded as well as JSON.
await app.register(formbody);

// Registered BEFORE the routes so its onRequest hook runs for all of them.
await app.register(jwtAuthPlugin, {
  deps,
  options: {
    publicKeyPem: cfg.JWT_PUBLIC_KEY,
    jwksJson: cfg.JWT_JWKS,
    issuer: cfg.JWT_ISSUER,
    audience: cfg.JWT_AUDIENCE,
    clockToleranceSec: 60,
  },
});

registerOAuthRoutes(app, deps);
registerIngestRoutes(app, deps);
registerWebhookRoutes(app, deps);
registerInvoiceRoutes(app, deps);
registerVendorRoutes(app, deps);
registerReviewUiRoutes(app, deps);

shutdown.register({
  name: 'http-server',
  order: 10,
  // Fastify stops accepting new connections and drains keep-alives.
  run: () => app.close(),
});
shutdown.register({ name: 'queues', order: 20, run: () => queues.close() });
shutdown.register({ name: 'redis', order: 30, run: () => Promise.resolve(redis.disconnect()) });
shutdown.register({ name: 'database', order: 40, run: () => db.close() });
shutdown.register({
  name: 'document-store',
  order: 50,
  run: () => Promise.resolve(documents.destroy()),
});

await app.listen({ port: cfg.HTTP_PORT, host: cfg.HTTP_HOST });
logger.info({ port: cfg.HTTP_PORT }, 'api listening');
