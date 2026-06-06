/**
 * Distributed per-realm rate limiting.
 *
 * Intuit enforces roughly 500 requests/minute per realm and about 10 concurrent
 * requests. Those are PER REALM, not per client, so every worker process in the
 * fleet shares one budget for a given tenant. A local in-process limiter cannot
 * express that — with 40 worker pods, each allowing a "safe" 100 rpm, the realm
 * sees 4000 rpm and Intuit starts throttling everyone.
 *
 * So the budget lives in Redis:
 *   - a token bucket for the sustained rate, refilled lazily,
 *   - a concurrency semaphore with a lease TTL, so a worker that dies holding a
 *     slot releases it automatically instead of leaking capacity forever.
 *
 * Both are single Lua scripts: atomic, one round trip, no read-modify-write race.
 */

import type { Redis } from 'ioredis';
import { RateLimitError } from '@onelineflow/core';

/**
 * Token bucket.
 *
 * KEYS[1] bucket hash. ARGV: capacity, refillPerSec, nowMs, requested, ttlSec.
 * Returns {allowed, waitMs, remaining}.
 */
const TOKEN_BUCKET_LUA = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local requested  = tonumber(ARGV[4])
local ttl        = tonumber(ARGV[5])

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

-- Lazy refill: no background timer, no drift.
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refillRate)

if tokens >= requested then
  tokens = tokens - requested
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('EXPIRE', key, ttl)
  return {1, 0, math.floor(tokens)}
end

-- Not enough: tell the caller exactly how long to wait rather than making it poll.
local deficit = requested - tokens
local waitMs  = math.ceil((deficit / refillRate) * 1000)
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)
return {0, waitMs, math.floor(tokens)}
`;

/**
 * Concurrency semaphore backed by a sorted set of leases.
 *
 * Stale entries are pruned by score (expiry timestamp) on every acquire, so a
 * crashed holder cannot permanently consume a slot.
 */
const SEMAPHORE_ACQUIRE_LUA = `
local key     = KEYS[1]
local limit   = tonumber(ARGV[1])
local now     = tonumber(ARGV[2])
local leaseMs = tonumber(ARGV[3])
local token   = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, now + leaseMs, token)
  redis.call('PEXPIRE', key, leaseMs * 2)
  return 1
end
return 0
`;

export interface RateLimiterOptions {
  readonly requestsPerMinute: number;
  readonly maxConcurrent: number;
  /** How long a concurrency slot is held before being reclaimed as stale. */
  readonly leaseMs: number;
  readonly keyPrefix: string;
}

export interface Lease {
  release(): Promise<void>;
}

export class QboRateLimiter {
  private readonly refillPerSec: number;

  constructor(
    private readonly redis: Redis,
    private readonly opts: RateLimiterOptions,
  ) {
    this.refillPerSec = opts.requestsPerMinute / 60;
  }

  private bucketKey(realmId: string): string {
    return `${this.opts.keyPrefix}:rl:bucket:${realmId}`;
  }

  private semKey(realmId: string): string {
    return `${this.opts.keyPrefix}:rl:sem:${realmId}`;
  }

  /**
   * Wait until both a rate token and a concurrency slot are available, then
   * return a lease the caller must release.
   *
   * Deliberately blocking rather than throwing: the caller is a queue worker,
   * and shedding the job would just re-enqueue it and re-enter here. Blocking
   * with a real deadline applies backpressure where it belongs.
   */
  async acquire(realmId: string, deadlineMs: number, signal?: AbortSignal): Promise<Lease> {
    const deadline = Date.now() + deadlineMs;

    // 1. Sustained rate.
    for (;;) {
      signal?.throwIfAborted();
      const now = Date.now();
      const [allowed, waitMs] = (await this.redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        this.bucketKey(realmId),
        this.opts.requestsPerMinute,
        this.refillPerSec,
        now,
        1,
        120,
      )) as [number, number, number];

      if (allowed === 1) break;

      if (now + waitMs > deadline) {
        throw new RateLimitError(
          `Rate limit for realm ${realmId} would not clear before the deadline`,
          { retryAfterMs: waitMs, context: { realmId, waitMs } },
        );
      }
      await delay(Math.min(waitMs, 1000), signal);
    }

    // 2. Concurrency slot.
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (;;) {
      signal?.throwIfAborted();
      const ok = (await this.redis.eval(
        SEMAPHORE_ACQUIRE_LUA,
        1,
        this.semKey(realmId),
        this.opts.maxConcurrent,
        Date.now(),
        this.opts.leaseMs,
        token,
      )) as number;

      if (ok === 1) break;

      if (Date.now() > deadline) {
        throw new RateLimitError(`No concurrency slot for realm ${realmId} before the deadline`, {
          retryAfterMs: 250,
          context: { realmId },
        });
      }
      await delay(50 + Math.random() * 100, signal);
    }

    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await this.redis.zrem(this.semKey(realmId), token).catch(() => {
          // Slot expires on its own via the lease TTL; losing the explicit
          // release costs a little throughput, never correctness.
        });
      },
    };
  }

  /**
   * Apply a Retry-After from Intuit by draining the bucket, so the whole fleet
   * backs off together instead of each worker discovering the 429 separately.
   */
  async penalise(realmId: string, retryAfterMs: number): Promise<void> {
    const key = this.bucketKey(realmId);
    await this.redis.hmset(key, 'tokens', 0, 'ts', Date.now() + retryAfterMs);
    await this.redis.expire(key, 120);
  }

  async inspect(realmId: string): Promise<{ tokens: number; concurrent: number }> {
    const [tokens, concurrent] = await Promise.all([
      this.redis.hget(this.bucketKey(realmId), 'tokens'),
      this.redis.zcount(this.semKey(realmId), Date.now(), '+inf'),
    ]);
    return {
      tokens: tokens ? Math.floor(Number(tokens)) : this.opts.requestsPerMinute,
      concurrent,
    };
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
