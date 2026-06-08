/**
 * Per-tenant fair scheduling.
 *
 * Without this, a queue is first-come-first-served and the largest tenant owns
 * it. `TenantFairGate` caps how many jobs any one tenant may have in flight
 * across the whole fleet, so a 200k-invoice month-end burst from one company
 * cannot starve a company with three invoices.
 *
 * A job that cannot get a slot is deferred (re-queued with a delay) rather than
 * failed — it keeps its place in the world, just not at the front of the line.
 */

import type { Redis } from 'ioredis';
import type { TenantId } from '@onelineflow/core';

/**
 * KEYS[1] in-flight set. ARGV: limit, nowMs, leaseMs, token.
 * Prunes expired leases first so a crashed worker cannot hold a slot forever.
 */
const ACQUIRE_LUA = `
local key     = KEYS[1]
local limit   = tonumber(ARGV[1])
local now     = tonumber(ARGV[2])
local leaseMs = tonumber(ARGV[3])
local token   = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local inflight = redis.call('ZCARD', key)
if inflight < limit then
  redis.call('ZADD', key, now + leaseMs, token)
  redis.call('PEXPIRE', key, leaseMs * 2)
  return {1, inflight + 1}
end
return {0, inflight}
`;

export interface FairnessOptions {
  readonly keyPrefix: string;
  /** Fallback when a tenant has no explicit override. */
  readonly defaultLimit: number;
  /** How long a slot is held before being reclaimed as stale. */
  readonly leaseMs: number;
}

export interface FairSlot {
  readonly acquired: boolean;
  readonly inFlight: number;
  release(): Promise<void>;
}

export class TenantFairGate {
  constructor(
    private readonly redis: Redis,
    private readonly opts: FairnessOptions,
  ) {}

  private key(queue: string, tenantId: TenantId): string {
    return `${this.opts.keyPrefix}:fair:${queue}:${tenantId}`;
  }

  async acquire(
    queue: string,
    tenantId: TenantId,
    limit = this.opts.defaultLimit,
  ): Promise<FairSlot> {
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const key = this.key(queue, tenantId);

    const [ok, inFlight] = (await this.redis.eval(
      ACQUIRE_LUA,
      1,
      key,
      limit,
      Date.now(),
      this.opts.leaseMs,
      token,
    )) as [number, number];

    if (ok !== 1) {
      return { acquired: false, inFlight, release: async () => {} };
    }

    let released = false;
    return {
      acquired: true,
      inFlight,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await this.redis.zrem(key, token).catch(() => {
          // Lease TTL reclaims it; losing the release costs throughput only.
        });
      },
    };
  }

  /**
   * Extend a lease for a long-running job. Without this, a slow extraction
   * (a 40-page scan, 90 seconds of model time) has its slot reclaimed while it
   * is still running, and the tenant over-subscribes.
   */
  async heartbeat(queue: string, tenantId: TenantId, token: string): Promise<void> {
    await this.redis.zadd(this.key(queue, tenantId), Date.now() + this.opts.leaseMs, token);
  }

  async inFlight(queue: string, tenantId: TenantId): Promise<number> {
    return this.redis.zcount(this.key(queue, tenantId), Date.now(), '+inf');
  }
}

/**
 * Backoff for a deferred job.
 *
 * Jittered so a thousand deferred jobs for one tenant do not all wake at the
 * same millisecond and re-stampede the gate.
 */
export function deferralDelayMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.floor(base / 2 + Math.random() * (base / 2));
}
