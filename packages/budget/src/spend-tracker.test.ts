import { describe, expect, it } from 'vitest';
import {
  decideFromBudget,
  formatMicros,
  MICROS_PER_CENT,
  periodKey,
  secondsUntilPeriodEnd,
  type BudgetStatus,
} from './spend-tracker.js';
import type { TenantId } from '@onelineflow/core';

const TENANT = '11111111-1111-4111-8111-111111111111' as TenantId;

function status(spentMicros: bigint, budgetMicros: bigint, hardStopAt = 1.05): BudgetStatus {
  const utilisation = budgetMicros > 0n ? Number(spentMicros) / Number(budgetMicros) : 0;
  return {
    tenantId: TENANT,
    spentMicros,
    budgetMicros,
    remainingMicros: budgetMicros > spentMicros ? budgetMicros - spentMicros : 0n,
    utilisation,
    exhausted: budgetMicros > 0n && utilisation >= hardStopAt,
    warning: budgetMicros > 0n && utilisation >= 0.8,
  };
}

describe('budget policy', () => {
  it('proceeds normally well under budget', () => {
    expect(decideFromBudget(status(10n, 100n)).action).toBe('proceed');
  });

  it('drops the second model at the warning threshold', () => {
    // Degrade before stopping: the second opinion is the expensive half, and
    // the confidence gate still routes anything uncertain to a human.
    const decision = decideFromBudget(status(85n, 100n));
    expect(decision.action).toBe('proceed_single_model');
  });

  it('routes to review rather than dropping the invoice when exhausted', () => {
    // An invoice is a payable the business owes. Refusing to process it because
    // OUR model spend hit a ceiling turns our cost problem into their
    // late-payment problem.
    const decision = decideFromBudget(status(110n, 100n));
    expect(decision.action).toBe('route_to_review');
    if (decision.action === 'route_to_review') {
      expect(decision.reason).toMatch(/rather than dropped/);
    }
  });

  it('treats an unset budget as unlimited, not as zero', () => {
    // A tenant whose budget was never configured must not have their pipeline
    // silently stopped by a default.
    const unlimited = status(999_999n, 0n);
    expect(unlimited.exhausted).toBe(false);
    expect(decideFromBudget(unlimited).action).toBe('proceed');
  });

  it('allows a bounded overshoot past 100%', () => {
    // The counter is eventually consistent across workers, so a hard stop
    // exactly at 1.0 would fire unpredictably. Overshooting by a known amount
    // is more defensible than an unpredictable cutoff.
    expect(decideFromBudget(status(101n, 100n)).action).toBe('proceed_single_model');
    expect(decideFromBudget(status(106n, 100n)).action).toBe('route_to_review');
  });
});

describe('period handling', () => {
  it('keys by calendar month in UTC', () => {
    expect(periodKey(new Date('2026-03-15T12:00:00Z'))).toBe('2026-03');
    expect(periodKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  it('zero-pads single-digit months', () => {
    expect(periodKey(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01');
  });

  it('does not roll the period early near a month boundary in another zone', () => {
    // 31 Dec 23:00 UTC is already January in +02:00. Using UTC consistently
    // keeps the counter aligned with the SQL date_trunc that seeds it.
    expect(periodKey(new Date('2026-12-31T23:00:00Z'))).toBe('2026-12');
  });

  it('expires the counter after the period ends, with slack', () => {
    const ttl = secondsUntilPeriodEnd(new Date('2026-03-30T00:00:00Z'));
    expect(ttl).toBeGreaterThan(86_400); // at least the slack day
    expect(ttl).toBeLessThan(5 * 86_400);
  });

  it('still gives a positive TTL on the last second of a month', () => {
    // A zero or negative TTL would delete the counter mid-period and lose the
    // month's spend.
    expect(secondsUntilPeriodEnd(new Date('2026-03-31T23:59:59Z'))).toBeGreaterThan(0);
  });
});

describe('formatMicros', () => {
  it('renders micros as a decimal currency amount', () => {
    expect(formatMicros((1_000_000n * MICROS_PER_CENT) / 100n)).toBe('100.00');
    expect(formatMicros(10_000n)).toBe('0.01');
    expect(formatMicros(0n)).toBe('0.00');
  });

  it('pads the fractional part', () => {
    expect(formatMicros(50_000n)).toBe('0.05');
  });
});
