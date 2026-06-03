/**
 * Backoff and retry.
 *
 * Full jitter (AWS's "Exponential Backoff and Jitter") rather than plain
 * exponential. With thousands of workers hitting one upstream, undithered backoff
 * synchronises every client onto the same retry instants and turns a brief blip
 * into a self-inflicted thundering herd.
 */

import { isRetryable, TimeoutError, toAppError } from './errors.js';

export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly factor?: number;
  /** Injected for deterministic tests. */
  readonly random?: () => number;
}

export function fullJitterDelay(attempt: number, opts: BackoffOptions): number {
  const factor = opts.factor ?? 2;
  const rand = opts.random ?? Math.random;
  const ceiling = Math.min(opts.maxMs, opts.baseMs * factor ** Math.max(0, attempt));
  return Math.floor(rand() * ceiling);
}

export interface RetryOptions extends BackoffOptions {
  readonly attempts: number;
  readonly signal?: AbortSignal;
  readonly onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Overrides the default `isRetryable` classification. */
  readonly shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? isRetryable;
  let lastError: unknown;

  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    opts.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = attempt === opts.attempts - 1;
      if (isLast || !shouldRetry(err)) break;

      // Honour an upstream Retry-After over our own computed backoff.
      const app = toAppError(err);
      const delay = app.retryAfterMs ?? fullJitterDelay(attempt, opts);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // Do not hold the event loop open purely for a backoff sleep.
    timer.unref?.();

    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` under a hard deadline. Combines with any caller-supplied signal so
 * shutdown still cancels in-flight work promptly.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new TimeoutError(`${label} exceeded ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onOuterAbort = (): void => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}
