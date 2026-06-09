/**
 * Structured logging.
 *
 * Rules that matter at 2M invoices/day:
 *   - JSON always. Nobody greps 2M lines; they query them.
 *   - tenant_id and invoice_id on every line, via child loggers, so a support
 *     question ("what happened to invoice X?") is one query, not a hunt.
 *   - Redaction at the serialiser, not the call site. A token cannot leak
 *     because someone forgot.
 *   - Sampling for high-cardinality debug lines, so a single tenant's burst
 *     cannot blow the logging budget for everyone.
 */

import { pino, type Logger as PinoLogger } from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Logger = PinoLogger;

export interface RequestContext {
  readonly requestId: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly invoiceId?: string;
  readonly jobId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Bind a context for the duration of `fn`; every log inside inherits it. */
export function withContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.client_secret',
  '*.password',
  'tokens',
];

export function createLogger(opts: {
  level: string;
  serviceName: string;
  environment: string;
  pretty?: boolean;
}): Logger {
  return pino({
    level: opts.level,
    base: { service: opts.serviceName, env: opts.environment, pid: process.pid },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // ISO timestamps: log aggregators handle them without a custom parser.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // Merge the async-local context into every line automatically.
      log: (obj) => {
        const ctx = storage.getStore();
        return ctx ? { ...ctx, ...obj } : obj;
      },
    },
    ...(opts.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,service,env' },
          },
        }
      : {}),
  });
}

/**
 * Deterministic sampler for high-volume debug logging.
 *
 * Hashing the key rather than using Math.random means the SAME invoice is
 * either always logged or never logged — a sampled trace you can actually
 * follow end to end, instead of a scatter of disconnected lines.
 */
export function shouldSample(key: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000 < rate;
}
