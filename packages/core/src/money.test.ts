import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import { ValidationError } from './errors.js';

describe('Money', () => {
  describe('float avoidance', () => {
    it('adds amounts that would drift as floats', () => {
      // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
      const a = Money.fromDecimalString('0.10', 'USD');
      const b = Money.fromDecimalString('0.20', 'USD');
      expect(a.add(b).toDecimalString()).toBe('0.30');
    });

    it('sums a thousand cents without drift', () => {
      const cents = Array.from({ length: 1000 }, () => Money.fromDecimalString('0.01', 'USD'));
      expect(Money.sum(cents, 'USD').toDecimalString()).toBe('10.00');
    });

    it('handles amounts beyond Number.MAX_SAFE_INTEGER minor units', () => {
      const huge = Money.fromMinor('9007199254740993', 'USD'); // 2^53 + 1
      expect(huge.minor).toBe(9007199254740993n);
      expect(huge.add(Money.fromMinor(1n, 'USD')).minor).toBe(9007199254740994n);
    });
  });

  describe('currency exponents', () => {
    it('treats JPY as zero-decimal', () => {
      const jpy = Money.fromDecimalString('1000', 'JPY');
      expect(jpy.minor).toBe(1000n);
      expect(jpy.toDecimalString()).toBe('1000');
    });

    it('treats KWD as three-decimal', () => {
      const kwd = Money.fromDecimalString('1.500', 'KWD');
      expect(kwd.minor).toBe(1500n);
      expect(kwd.toDecimalString()).toBe('1.500');
    });

    it('defaults unknown currencies to two decimals', () => {
      expect(Money.fromDecimalString('5.25', 'NGN').minor).toBe(525n);
    });
  });

  describe('parsing', () => {
    it('rejects more precision than the currency allows rather than rounding', () => {
      // Silently rounding here is how a cent goes missing on every invoice.
      expect(() => Money.fromDecimalString('1.005', 'USD')).toThrow(ValidationError);
    });

    it('rejects thousands separators as ambiguous', () => {
      // "1,234" is 1234 in en-US and 1.234 in de-DE. Refuse rather than guess.
      expect(() => Money.fromDecimalString('1,234.00', 'USD')).toThrow(ValidationError);
    });

    it('rejects currency symbols', () => {
      expect(() => Money.fromDecimalString('$100.00', 'USD')).toThrow(ValidationError);
    });

    it('parses negatives', () => {
      expect(Money.fromDecimalString('-42.50', 'USD').minor).toBe(-4250n);
    });

    it('pads short fractions', () => {
      expect(Money.fromDecimalString('1.5', 'USD').minor).toBe(150n);
    });

    it('rejects a malformed currency code', () => {
      expect(() => Money.fromDecimalString('1.00', 'US')).toThrow(ValidationError);
    });
  });

  describe('currency safety', () => {
    it('refuses to add across currencies', () => {
      const usd = Money.fromDecimalString('10.00', 'USD');
      const eur = Money.fromDecimalString('10.00', 'EUR');
      expect(() => usd.add(eur)).toThrow(/without an explicit FX conversion/);
    });

    it('refuses to compare across currencies', () => {
      const usd = Money.fromDecimalString('10.00', 'USD');
      const gbp = Money.fromDecimalString('10.00', 'GBP');
      expect(() => usd.compare(gbp)).toThrow(ValidationError);
    });

    it('treats different currencies as unequal, not throwing', () => {
      const usd = Money.fromDecimalString('10.00', 'USD');
      const eur = Money.fromDecimalString('10.00', 'EUR');
      expect(usd.equals(eur)).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('survives JSON serialisation exactly', () => {
      const original = Money.fromDecimalString('123456789.99', 'EUR');
      const restored = Money.fromJSON(JSON.parse(JSON.stringify(original)));
      expect(restored.equals(original)).toBe(true);
    });

    it('produces a lossless QBO amount', () => {
      expect(Money.fromDecimalString('1234.56', 'USD').toQboAmount()).toBe(1234.56);
      expect(Money.fromDecimalString('0.01', 'USD').toQboAmount()).toBe(0.01);
    });

    it('rejects a QBO amount that cannot round-trip', () => {
      // Far beyond double precision for cents.
      const absurd = Money.fromMinor('99999999999999999999', 'USD');
      expect(() => absurd.toQboAmount()).toThrow(/losslessly/);
    });
  });

  it('is immutable', () => {
    const m = Money.fromDecimalString('1.00', 'USD');
    expect(Object.isFrozen(m)).toBe(true);
    expect(m.add(Money.fromDecimalString('1.00', 'USD')).minor).toBe(200n);
    expect(m.minor).toBe(100n); // original untouched
  });
});
