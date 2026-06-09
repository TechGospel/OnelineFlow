/**
 * Extraction worker.
 *
 * Fetches the document, runs the primary model, escalates to a second model only
 * when confidence warrants it, then routes the invoice either to the approval
 * queue or to human review.
 *
 * Cost is the dominant operational concern here. At 2M documents/day a careless
 * escalation policy is the difference between a viable unit economic and an
 * unviable one, which is why `needsSecondOpinion` gates it and why per-tenant
 * spend is checked before the call rather than after.
 */

import { Redis } from 'ioredis';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  asInvoiceId,
  asTenantId,
  businessDuplicateKey,
  hasBlockingFinding,
  loadConfig,
  Money,
  toAppError,
  ValidationError,
} from '@onelineflow/core';
import { Database, enqueueOutbox, InvoiceRepository } from '@onelineflow/db';
import {
  GoogleAiProvider,
  needsSecondOpinion,
  OpenAiProvider,
  reachConsensus,
  type ExtractionProvider,
  type ExtractionResult,
} from '@onelineflow/ai';
import {
  aiCostMicros,
  createLogger,
  extractionConfidence,
  extractionDuration,
  invoiceTransitions,
  metricsText,
  ShutdownManager,
  withContext,
} from '@onelineflow/observability';
import {
  buildConnection,
  QUEUE_NAMES,
  TenantFairGate,
  Worker,
  type ExtractionJob,
} from '@onelineflow/queue';
import { createServer } from 'node:http';

const cfg = loadConfig();
const logger = createLogger({
  level: cfg.LOG_LEVEL,
  serviceName: 'worker-extraction',
  environment: cfg.NODE_ENV,
  pretty: cfg.NODE_ENV === 'development',
});

const shutdown = new ShutdownManager(logger);
shutdown.install();

const db = new Database({
  connectionString: cfg.DATABASE_URL,
  max: cfg.DB_POOL_MAX,
  statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS,
  applicationName: 'onelineflow-worker-extraction',
});
const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const invoices = new InvoiceRepository();

const s3 = new S3Client({
  endpoint: cfg.S3_ENDPOINT,
  region: cfg.S3_REGION,
  forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: cfg.S3_ACCESS_KEY_ID,
    secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
  },
});

/**
 * Provider ordering: cheapest capable model first, a different model family
 * second. Family diversity matters more than raw capability for the second
 * opinion — two models that fail the same way validate nothing.
 */
function buildProviders(): { primary: ExtractionProvider; secondary?: ExtractionProvider } {
  const google = cfg.GOOGLE_AI_API_KEY
    ? new GoogleAiProvider({
        apiKey: cfg.GOOGLE_AI_API_KEY,
        model: cfg.GOOGLE_AI_MODEL,
        timeoutMs: cfg.AI_REQUEST_TIMEOUT_MS,
        pricing: { inputMicrosPerMillion: 100_000n, outputMicrosPerMillion: 400_000n },
      })
    : undefined;

  const openai = cfg.OPENAI_API_KEY
    ? new OpenAiProvider({
        apiKey: cfg.OPENAI_API_KEY,
        model: cfg.OPENAI_MODEL,
        timeoutMs: cfg.AI_REQUEST_TIMEOUT_MS,
        pricing: { inputMicrosPerMillion: 150_000n, outputMicrosPerMillion: 600_000n },
      })
    : undefined;

  const primary = google ?? openai;
  if (!primary) {
    // loadConfig already guarantees one key exists; this keeps the types honest.
    throw new Error('No extraction provider configured');
  }
  const secondary = primary === google ? openai : google;
  return secondary ? { primary, secondary } : { primary };
}

const providers = buildProviders();
const fairGate = new TenantFairGate(redis, {
  keyPrefix: cfg.QUEUE_PREFIX,
  defaultLimit: 50,
  leaseMs: cfg.AI_REQUEST_TIMEOUT_MS * 3,
});

async function fetchDocument(storageKey: string): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: cfg.S3_BUCKET_DOCUMENTS, Key: storageKey }),
  );
  if (!res.Body) throw new ValidationError(`Document ${storageKey} has no body`);
  return Buffer.from(await res.Body.transformToByteArray());
}

const worker = new Worker<ExtractionJob>(
  QUEUE_NAMES.extraction,
  async (job) => {
    const tenantId = asTenantId(job.data.tenantId);
    const invoiceId = asInvoiceId(job.data.invoiceId);
    const createdAt = new Date(job.data.invoiceCreatedAt);

    const slot = await fairGate.acquire(QUEUE_NAMES.extraction, tenantId);
    if (!slot.acquired) {
      await job.moveToDelayed(Date.now() + 2_000 + Math.floor(Math.random() * 5_000));
      return { deferred: true };
    }

    try {
      return await withContext({ requestId: job.id ?? '', tenantId, invoiceId }, async () =>
        db.withTenant(tenantId, async (client) => {
          const invoice = await invoices.requireById(client, invoiceId);

          // Idempotency: a redelivered job for an invoice that has moved on is
          // a no-op, not an error.
          if (invoice.status !== 'received' && invoice.status !== 'failed') {
            logger.info({ status: invoice.status }, 'invoice is past extraction; skipping');
            return { skipped: true, status: invoice.status };
          }

          const claimed = await invoices.transitionStatus(client, {
            id: invoiceId,
            createdAt,
            from: invoice.status,
            to: 'extracting',
            expectedVersion: invoice.version,
          });
          invoiceTransitions.inc({ from: invoice.status, to: 'extracting' });

          const { rows } = await client.query<{ storage_key: string; content_type: string }>(
            `SELECT storage_key, content_type FROM documents WHERE id = $1`,
            [job.data.documentId],
          );
          const doc = rows[0];
          if (!doc) throw new ValidationError(`Document ${job.data.documentId} not found`);

          const bytes = await fetchDocument(doc.storage_key);

          /* --- Primary extraction ------------------------------------- */
          const started = Date.now();
          let primary: ExtractionResult;
          try {
            primary = await providers.primary.extract({
              documentBytes: bytes,
              mimeType: doc.content_type,
              signal: shutdown.signal,
            });
          } catch (err) {
            extractionDuration.observe(
              { model: providers.primary.model, outcome: 'error' },
              (Date.now() - started) / 1000,
            );
            throw err;
          }
          extractionDuration.observe(
            { model: primary.model, outcome: 'success' },
            primary.latencyMs / 1000,
          );
          aiCostMicros.inc(
            { provider: primary.provider, model: primary.model },
            Number(primary.costMicros),
          );

          /* --- Conditional second opinion ------------------------------ */
          let secondary: ExtractionResult | undefined;
          const opts = {
            autopostThreshold: cfg.AI_AUTOPOST_CONFIDENCE_THRESHOLD,
            consensusTriggerThreshold: cfg.AI_CONSENSUS_TRIGGER_THRESHOLD,
          };

          if (providers.secondary && needsSecondOpinion(primary, opts)) {
            try {
              secondary = await providers.secondary.extract({
                documentBytes: bytes,
                mimeType: doc.content_type,
                signal: shutdown.signal,
              });
              aiCostMicros.inc(
                { provider: secondary.provider, model: secondary.model },
                Number(secondary.costMicros),
              );
            } catch (err) {
              // A failed second opinion must not fail the invoice. Fall through
              // with the primary alone; the confidence gate then routes it to a
              // human, which is the safe default.
              logger.warn({ err }, 'second-opinion extraction failed; routing to review');
            }
          }

          const outcome = reachConsensus(primary, secondary, opts);
          extractionConfidence.observe(
            { consensus: String(Boolean(secondary)) },
            outcome.overallConfidence,
          );

          const total = Money.fromDecimalString(
            outcome.extracted.total,
            outcome.extracted.currency,
          );
          const businessKey = businessDuplicateKey(
            tenantId,
            outcome.extracted.vendorName,
            outcome.extracted.invoiceNumber,
            total.minor,
            outcome.extracted.currency,
          );

          return db.transaction(client, async (tx) => {
            await invoices.saveExtraction(tx, {
              id: invoiceId,
              tenantId,
              createdAt,
              extracted: outcome.extracted,
              total,
              overallConfidence: outcome.overallConfidence,
              models: outcome.models,
              costMicros: outcome.costMicros,
              businessKey,
            });

            /* --- Business-level duplicate check ----------------------- */
            const claim = await invoices.claimBusinessKey(tx, tenantId, businessKey, invoiceId);
            const findings = [...outcome.findings];
            if (!claim.claimed) {
              findings.push({
                code: 'DUPLICATE_INVOICE',
                severity: 'blocking',
                message:
                  `An invoice with the same vendor, number and amount already exists ` +
                  `(${claim.existingInvoiceId}).`,
              });
            }

            const target =
              hasBlockingFinding(findings) || outcome.requiresReview
                ? 'needs_review'
                : 'pending_approval';

            await invoices.transitionStatus(tx, {
              id: invoiceId,
              createdAt,
              from: 'extracting',
              to: target,
              expectedVersion: claimed.version,
              patch: { findings: JSON.stringify(findings) },
            });
            invoiceTransitions.inc({ from: 'extracting', to: target });

            await enqueueOutbox(tx, tenantId, {
              aggregateType: 'invoice',
              aggregateId: invoiceId,
              eventType: `invoice.${target}`,
              payload: {
                confidence: outcome.overallConfidence,
                models: outcome.models,
                findingCount: findings.length,
              },
            });

            return { status: target, confidence: outcome.overallConfidence };
          });
        }),
      );
    } catch (err) {
      const appErr = toAppError(err);
      if (!appErr.retryable) {
        await db
          .withTenant(tenantId, async (client) => {
            await client.query(
              `UPDATE invoices
                  SET status = 'failed', failure_code = $1, failure_message = $2,
                      version = version + 1, updated_at = now()
                WHERE id = $3 AND created_at = $4 AND status = 'extracting'`,
              [appErr.category, appErr.message.slice(0, 2000), invoiceId, createdAt],
            );
          })
          .catch((e: unknown) => logger.error({ err: e }, 'failed to park invoice'));
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
    lockDuration: cfg.AI_REQUEST_TIMEOUT_MS * 3,
    stalledInterval: 30_000,
  },
);

worker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, attempts: job?.attemptsMade, err }, 'extraction job failed'),
);
worker.on('error', (err) => logger.error({ err }, 'worker error'));

const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    void metricsText().then((b) =>
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(b),
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

shutdown.register({ name: 'stop-jobs', order: 10, run: () => worker.close(false) });
shutdown.register({
  name: 'metrics-server',
  order: 20,
  run: async () => new Promise<void>((r) => metricsServer.close(() => r())),
});
shutdown.register({ name: 'redis', order: 30, run: () => Promise.resolve(redis.disconnect()) });
shutdown.register({ name: 'database', order: 40, run: () => db.close() });

logger.info(
  {
    primary: providers.primary.model,
    secondary: providers.secondary?.model ?? '(none)',
    concurrency: cfg.WORKER_CONCURRENCY,
  },
  'extraction worker started',
);
