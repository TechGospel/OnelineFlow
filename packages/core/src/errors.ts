/**
 * Error taxonomy.
 *
 * The single most important property here is `retryable`. Every worker decides
 * whether to re-enqueue a job by asking the error, never by string-matching a
 * message. A misclassified error either wedges the queue (retrying a permanent
 * failure forever) or silently drops an invoice (dropping a transient one).
 */

export type ErrorCategory =
  | 'validation' // Caller sent something wrong. Never retry.
  | 'not_found'
  | 'conflict' // Optimistic-concurrency / duplicate. Never blind-retry.
  | 'auth' // Tenant must re-authorise. Not retryable without human action.
  | 'permission'
  | 'rate_limit' // Retry after a delay.
  | 'upstream' // Third party failed. Retry with backoff.
  | 'timeout'
  | 'config'
  | 'internal';

export interface ErrorContext {
  readonly [key: string]: unknown;
}

export interface AppErrorOptions {
  /** Shown to the tenant. Defaults to `message`, so keep messages presentable. */
  readonly publicMessage?: string;
  /** Structured detail for logs. Never rendered to a tenant. */
  readonly context?: ErrorContext;
  readonly cause?: unknown;
  /** Overrides computed backoff when the upstream told us how long to wait. */
  readonly retryAfterMs?: number;
  /** Offending field path, for validation errors surfaced in a UI. */
  readonly field?: string;
}

export abstract class AppError extends Error {
  abstract readonly category: ErrorCategory;
  abstract readonly retryable: boolean;
  /** HTTP status used when this surfaces through the API. */
  abstract readonly httpStatus: number;

  /** Safe to show a tenant. Internal details stay in `context` and the logs. */
  readonly publicMessage: string;
  readonly context: ErrorContext;
  /** Hint for the retry scheduler, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  /** Offending field, when the error is attributable to one. Drives form UX. */
  readonly field: string | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.publicMessage = options.publicMessage ?? message;
    this.context = Object.freeze({ ...options.context });
    this.retryAfterMs = options.retryAfterMs;
    this.field = options.field;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      ...(this.field !== undefined ? { field: this.field } : {}),
      context: this.context,
    };
  }
}

export class ValidationError extends AppError {
  readonly category = 'validation' as const;
  readonly retryable = false;
  readonly httpStatus = 422;
}

export class NotFoundError extends AppError {
  readonly category = 'not_found' as const;
  readonly retryable = false;
  readonly httpStatus = 404;
}

export class ConflictError extends AppError {
  readonly category = 'conflict' as const;
  readonly retryable = false;
  readonly httpStatus = 409;
}

/** Tenant's QBO grant is dead. A human must reconnect; retrying cannot help. */
export class AuthError extends AppError {
  readonly category = 'auth' as const;
  readonly retryable = false;
  readonly httpStatus = 401;
}

export class PermissionError extends AppError {
  readonly category = 'permission' as const;
  readonly retryable = false;
  readonly httpStatus = 403;
}

export class RateLimitError extends AppError {
  readonly category = 'rate_limit' as const;
  readonly retryable = true;
  readonly httpStatus = 429;
}

/** Third-party fault we expect to pass. Retry with exponential backoff. */
export class UpstreamError extends AppError {
  readonly category = 'upstream' as const;
  readonly retryable = true;
  readonly httpStatus = 502;
}

export class TimeoutError extends AppError {
  readonly category = 'timeout' as const;
  readonly retryable = true;
  readonly httpStatus = 504;
}

/** Operator misconfiguration. Retrying will fail identically. */
export class ConfigError extends AppError {
  readonly category = 'config' as const;
  readonly retryable = false;
  readonly httpStatus = 500;
}

export class InternalError extends AppError {
  readonly category = 'internal' as const;
  readonly retryable = true;
  readonly httpStatus = 500;
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Default to NOT retrying an unknown error.
 *
 * An unknown error is by definition one we have not reasoned about. Retrying it
 * risks duplicating a side effect we cannot see; parking it costs one manual
 * review. In a system that posts to a general ledger, that trade is not close.
 */
export function isRetryable(err: unknown): boolean {
  return isAppError(err) ? err.retryable : false;
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new InternalError(message, {
    publicMessage: 'An unexpected error occurred.',
    cause: err,
  });
}
