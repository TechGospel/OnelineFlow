/**
 * Configuration is parsed once, at process start, and the process refuses to boot
 * if anything is missing or malformed.
 *
 * A worker that starts happily and then throws on its first job — at 3am, at
 * month-end close — is far worse than one that never starts. Fail at boot.
 */

import { z } from 'zod';
import { ConfigError } from './errors.js';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const intFrom = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).default('onelineflow'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /* --- Postgres -------------------------------------------------------- */
  DATABASE_URL: z.string().url(),
  /** Read replica for the reconciler and dashboards. Falls back to primary. */
  DATABASE_REPLICA_URL: z.string().url().optional(),
  DB_POOL_MAX: intFrom(1, 200).default(20),
  DB_STATEMENT_TIMEOUT_MS: intFrom(100, 600_000).default(15_000),

  /* --- Redis / queue --------------------------------------------------- */
  REDIS_URL: z.string().url(),
  QUEUE_PREFIX: z.string().min(1).default('of'),
  /** Concurrency per worker process, not cluster-wide. */
  WORKER_CONCURRENCY: intFrom(1, 500).default(25),

  /* --- Object storage -------------------------------------------------- */
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET_DOCUMENTS: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default('true'),

  /* --- Encryption ------------------------------------------------------ */
  /**
   * Base64 32-byte root key for envelope encryption of tenant OAuth tokens.
   * In production this must come from KMS/Vault, never a plain env var — see
   * packages/crypto/src/keyring.ts.
   */
  ENCRYPTION_ROOT_KEY: z.string().min(44),
  ENCRYPTION_KEY_VERSION: intFrom(1, 1_000_000).default(1),

  /* --- Intuit / QBO ---------------------------------------------------- */
  QBO_CLIENT_ID: z.string().min(1),
  QBO_CLIENT_SECRET: z.string().min(1),
  QBO_REDIRECT_URI: z.string().url(),
  QBO_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  QBO_MINOR_VERSION: z.string().regex(/^\d+$/).default('75'),
  /** Intuit's documented ceiling is 500 req/min/realm; leave headroom. */
  QBO_RATE_LIMIT_PER_MIN: intFrom(1, 500).default(450),
  QBO_MAX_CONCURRENT_PER_REALM: intFrom(1, 10).default(8),
  QBO_REQUEST_TIMEOUT_MS: intFrom(1_000, 120_000).default(30_000),
  QBO_WEBHOOK_VERIFIER_TOKEN: z.string().min(1).optional(),

  /* --- AI extraction --------------------------------------------------- */
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  GOOGLE_AI_API_KEY: z.string().min(1).optional(),
  GOOGLE_AI_MODEL: z.string().min(1).default('gemini-2.0-flash'),
  /** Below this, an invoice always goes to a human regardless of consensus. */
  AI_AUTOPOST_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.95),
  /** Run the second model only when the first is below this. Cost control. */
  AI_CONSENSUS_TRIGGER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.98),
  AI_REQUEST_TIMEOUT_MS: intFrom(1_000, 300_000).default(90_000),

  /* --- API ------------------------------------------------------------- */
  HTTP_PORT: intFrom(1, 65_535).default(3000),
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_BODY_LIMIT_BYTES: intFrom(1024, 100 * 1024 * 1024).default(25 * 1024 * 1024),
  JWT_PUBLIC_KEY: z.string().min(1).optional(),

  /* --- Observability --------------------------------------------------- */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  METRICS_PORT: intFrom(1, 65_535).default(9464),
});

export type Config = z.infer<typeof configSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }

  const cfg = parsed.data;

  // Cross-field rules the schema cannot express on its own.
  if (!cfg.OPENAI_API_KEY && !cfg.GOOGLE_AI_API_KEY) {
    throw new ConfigError(
      'At least one of OPENAI_API_KEY or GOOGLE_AI_API_KEY must be set for extraction to work.',
    );
  }
  if (cfg.AI_CONSENSUS_TRIGGER_THRESHOLD < cfg.AI_AUTOPOST_CONFIDENCE_THRESHOLD) {
    throw new ConfigError(
      'AI_CONSENSUS_TRIGGER_THRESHOLD must be >= AI_AUTOPOST_CONFIDENCE_THRESHOLD, ' +
        'otherwise invoices could auto-post without ever triggering the second model.',
    );
  }
  if (cfg.NODE_ENV === 'production') {
    if (cfg.QBO_ENVIRONMENT !== 'production') {
      throw new ConfigError('Refusing to run NODE_ENV=production against the QBO sandbox.');
    }
    if (!cfg.QBO_WEBHOOK_VERIFIER_TOKEN) {
      throw new ConfigError('QBO_WEBHOOK_VERIFIER_TOKEN is required in production.');
    }
    if (!cfg.JWT_PUBLIC_KEY) {
      throw new ConfigError('JWT_PUBLIC_KEY is required in production.');
    }
  }

  cached = Object.freeze(cfg);
  return cached;
}

/** Test-only. Clears the memoised config so a suite can vary the environment. */
export function resetConfigForTests(): void {
  cached = undefined;
}

export type QboEnvironment = 'sandbox' | 'production';

export function qboBaseUrl(environment: QboEnvironment): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

export const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
