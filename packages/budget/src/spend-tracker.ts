/**
 * Per-tenant AI spend tracking and enforcement.
 *
 * At 2M documents/day, extraction is the dominant variable cost. A single tenant
 * uploading a 400-page scanned archive can burn a month's budget in an hour, and
 * without a ceiling the first anyone knows is the invoice from the model
 * provider.
 *
 * Two design decisions carry most of the weight:
 *
 * **Redis holds the running counter, Postgres holds the truth.** Summing
 * `extraction_cost_micros` per tenant per month on every invoice would be a
 * 60M-row aggregate on the hot path. Instead Redis carries an INCRBY counter
 * seeded from Postgres on a cache miss, with a TTL past month end. Redis losing
 * the key costs one re-seed query, not a lost budget.
 *
 * **Exceeding the budget does NOT drop the invoice.** It routes to human review.
 * An invoice is a payable a business owes; refusing to process it because our
 * model spend hit a ceiling turns our cost problem into their late-payment
 * problem. The tenant gets an alert and a review queue, not silence.
 */

import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { TenantId } from '@onelineflow/core';

/** Millionths of a currency unit, matching `extraction_cost_micros`. */
export type Micros = bigint;

export const MICROS_PER_CENT = 10_000n;

export interface BudgetStatus {
  readonly tenantId: TenantId;
  readonly spentMicros: Micros;
  readonly budgetMicros: Micros;
  readonly remainingMicros: Micros;
  /** Fraction of budget consumed; can exceed 1. */
  readonly utilisation: number;
  /** Hard stop: no further model calls this period. */
  readonly exhausted: boolean;
  /** Soft warning threshold crossed. */
  readonly warning: boolean;
}

export interface SpendTrackerOptions {
  readonly keyPrefix: string;
  /** Warn at this utilisation. Default 0.8. */
  readonly warnAt?: number;
  /**
   * Allow spend up to this multiple of the budget before hard-stopping.
   *
   * Slightly above 1 on purpose: the counter is eventually consistent across
   * workers, so a hard stop exactly at 1.0 would fire unpredictably a few
   * invoices either side. Overshooting by a bounded, known amount is more
   * defensible than an unpredictable cutoff.
   */
  readonly hardStopAt?: number;
}

/** Calendar month key. Budgets reset monthly, matching how they are billed. */
export function periodKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Seconds until the end of the current UTC month, plus a day of slack. */
export function secondsUntilPeriodEnd(now: Date = new Date()): number {
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.ceil((nextMonth - now.getTime()) / 1000) + 86_400;
}

export class SpendTracker {
  private readonly warnAt: number;
  private readonly hardStopAt: number;

  constructor(
    private readonly redis: Redis,
    private readonly opts: SpendTrackerOptions,
  ) {
    this.warnAt = opts.warnAt ?? 0.8;
    this.hardStopAt = opts.hardStopAt ?? 1.05;
  }

  private key(tenantId: TenantId, period: string): string {
    return `${this.opts.keyPrefix}:spend:${period}:${tenantId}`;
  }

  /**
   * Read spend, seeding from Postgres if Redis has no counter yet.
   *
   * The seed is deliberately a range scan over the current month only, which
   * hits `invoices_tenant_created_idx` and prunes to at most two partitions.
   */
  private async currentSpend(
    client: pg.PoolClient,
    tenantId: TenantId,
    period: string,
  ): Promise<Micros> {
    const key = this.key(tenantId, period);
    const cached = await this.redis.get(key);
    if (cached !== null) return BigInt(cached);

    const { rows } = await client.query<{ total: string }>(
      `SELECT coalesce(sum(extraction_cost_micros), 0)::text AS total
         FROM invoices
        WHERE tenant_id = $1
          AND created_at >= date_trunc('month', now())
          AND created_at <  date_trunc('month', now()) + interval '1 month'`,
      [tenantId],
    );
    const seeded = BigInt(rows[0]?.total ?? '0');

    // NX so a concurrent worker that seeded first wins; otherwise two seeds
    // racing would clobber increments recorded between them.
    await this.redis.set(key, seeded.toString(), 'EX', secondsUntilPeriodEnd(), 'NX');
    const after = await this.redis.get(key);
    return after === null ? seeded : BigInt(after);
  }

  private async budgetFor(client: pg.PoolClient, tenantId: TenantId): Promise<Micros> {
    const { rows } = await client.query<{ cents: string }>(
      `SELECT ai_monthly_budget_cents::text AS cents FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return BigInt(rows[0]?.cents ?? '0') * MICROS_PER_CENT;
  }

  /** Current status without reserving anything. */
  async status(client: pg.PoolClient, tenantId: TenantId): Promise<BudgetStatus> {
    const period = periodKey();
    const [spent, budget] = await Promise.all([
      this.currentSpend(client, tenantId, period),
      this.budgetFor(client, tenantId),
    ]);
    return this.evaluate(tenantId, spent, budget);
  }

  private evaluate(tenantId: TenantId, spent: Micros, budget: Micros): BudgetStatus {
    // A zero or negative budget means unlimited, not "spend nothing". A tenant
    // whose budget was never configured must not have their pipeline silently
    // stopped by a default.
    if (budget <= 0n) {
      return {
        tenantId,
        spentMicros: spent,
        budgetMicros: 0n,
        remainingMicros: 0n,
        utilisation: 0,
        exhausted: false,
        warning: false,
      };
    }

    const utilisation = Number(spent) / Number(budget);
    return {
      tenantId,
      spentMicros: spent,
      budgetMicros: budget,
      remainingMicros: budget > spent ? budget - spent : 0n,
      utilisation,
      exhausted: utilisation >= this.hardStopAt,
      warning: utilisation >= this.warnAt,
    };
  }

  /**
   * Record spend after a model call.
   *
   * Called AFTER the call, not before, because the true cost is only known from
   * the token counts in the response. That means a burst can overshoot by up to
   * one round of in-flight calls, which is why `hardStopAt` sits above 1.0
   * rather than pretending the counter is exact.
   */
  async record(
    client: pg.PoolClient,
    tenantId: TenantId,
    costMicros: Micros,
  ): Promise<BudgetStatus> {
    if (costMicros < 0n) throw new Error('Spend cannot be negative');
    const period = periodKey();
    const key = this.key(tenantId, period);

    // Seed first so the increment lands on a real base rather than on 0.
    await this.currentSpend(client, tenantId, period);

    const spent = await this.redis.incrby(key, Number(costMicros));
    // Re-assert the TTL: INCRBY on an existing key does not refresh it, and a
    // key that outlives its period would carry spend into the next month.
    await this.redis.expire(key, secondsUntilPeriodEnd());

    const budget = await this.budgetFor(client, tenantId);
    return this.evaluate(tenantId, BigInt(spent), budget);
  }

  /**
   * Reconcile the Redis counter against Postgres.
   *
   * Redis is eventually consistent with the ledger: a worker that crashes
   * between the model call and the INCRBY loses that increment. Run periodically
   * from the scheduler so drift cannot accumulate across a month.
   */
  async reconcile(
    client: pg.PoolClient,
    tenantId: TenantId,
  ): Promise<{ before: Micros; after: Micros }> {
    const period = periodKey();
    const key = this.key(tenantId, period);

    const before = BigInt((await this.redis.get(key)) ?? '0');
    const { rows } = await client.query<{ total: string }>(
      `SELECT coalesce(sum(extraction_cost_micros), 0)::text AS total
         FROM invoices
        WHERE tenant_id = $1
          AND created_at >= date_trunc('month', now())
          AND created_at <  date_trunc('month', now()) + interval '1 month'`,
      [tenantId],
    );
    const after = BigInt(rows[0]?.total ?? '0');

    await this.redis.set(key, after.toString(), 'EX', secondsUntilPeriodEnd());
    return { before, after };
  }
}

/**
 * What the extraction worker should do given a budget status.
 *
 * Separated from the tracker so the policy is testable without Redis, and so
 * the decision is stated in one place rather than inferred from branches
 * scattered through the worker.
 */
export type BudgetDecision =
  | { action: 'proceed' }
  | { action: 'proceed_single_model'; reason: string }
  | { action: 'route_to_review'; reason: string };

export function decideFromBudget(status: BudgetStatus): BudgetDecision {
  if (status.exhausted) {
    return {
      action: 'route_to_review',
      reason:
        `AI budget exhausted for this period (${formatMicros(status.spentMicros)} of ` +
        `${formatMicros(status.budgetMicros)}). Invoices are queued for manual review ` +
        'rather than dropped.',
    };
  }

  if (status.warning) {
    // Degrade before stopping: drop the second opinion, which is the expensive
    // half. Confidence gating still routes anything uncertain to a human, so
    // this trades some automation for cost without weakening the safety story.
    return {
      action: 'proceed_single_model',
      reason: `AI budget ${Math.round(status.utilisation * 100)}% consumed; skipping the second model`,
    };
  }

  return { action: 'proceed' };
}

export function formatMicros(micros: Micros): string {
  const cents = micros / MICROS_PER_CENT;
  const whole = cents / 100n;
  const frac = (cents < 0n ? -cents : cents) % 100n;
  return `${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}
