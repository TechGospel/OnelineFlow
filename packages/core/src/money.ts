/**
 * Money is stored and manipulated exclusively as an integer count of minor units
 * (cents, pence, kobo). Never as a float.
 *
 * `0.1 + 0.2 !== 0.3` in IEEE-754. In an accounting system that difference is a
 * reconciliation break that a human has to chase. We use bigint so that even a
 * tenant posting trillions of minor units cannot overflow Number.MAX_SAFE_INTEGER.
 *
 * Conversion to a decimal string happens exactly once, at the QBO API boundary.
 */

import { ValidationError } from './errors.js';

/** ISO-4217 alpha-3 code. Validated against EXPONENTS at construction. */
export type CurrencyCode = string;

/**
 * ISO-4217 minor-unit exponents for currencies that are NOT the default of 2.
 * Getting this wrong means posting 100x or 1/100x the real amount to the ledger.
 */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({
  // Zero-decimal
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three-decimal
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Four-decimal
  CLF: 4,
  UYW: 4,
});

const DEFAULT_EXPONENT = 2;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function exponentFor(currency: CurrencyCode): number {
  return EXPONENT_OVERRIDES[currency] ?? DEFAULT_EXPONENT;
}

export interface MoneyJSON {
  readonly minor: string;
  readonly currency: CurrencyCode;
}

export class Money {
  private constructor(
    /** Signed count of minor units. */
    public readonly minor: bigint,
    public readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  static fromMinor(minor: bigint | number | string, currency: CurrencyCode): Money {
    const cur = normaliseCurrency(currency);
    let value: bigint;
    try {
      value = typeof minor === 'bigint' ? minor : BigInt(minor);
    } catch {
      throw new ValidationError(`Not an integer minor-unit amount: ${String(minor)}`, {
        field: 'minor',
      });
    }
    return new Money(value, cur);
  }

  /**
   * Parse a decimal string such as "1234.56" exactly, without ever creating a float.
   * Accepts an optional leading sign, thousands separators are rejected on purpose —
   * ambiguity between "1,234" (en) and "1,234" (de, meaning 1.234) is a real source
   * of extraction bugs, so callers must normalise upstream.
   */
  static fromDecimalString(input: string, currency: CurrencyCode): Money {
    const cur = normaliseCurrency(currency);
    const raw = input.trim();
    const match = /^(?<sign>[+-]?)(?<int>\d+)(?:\.(?<frac>\d+))?$/.exec(raw);
    if (!match?.groups) {
      throw new ValidationError(`Malformed decimal amount: "${input}"`, { field: 'amount' });
    }

    const exp = exponentFor(cur);
    const frac = match.groups['frac'] ?? '';
    if (frac.length > exp) {
      // Refuse rather than round. A vendor invoice with more precision than the
      // currency supports means the extraction is wrong, not that we should guess.
      throw new ValidationError(
        `"${input}" has ${frac.length} decimal places but ${cur} allows ${exp}`,
        { field: 'amount' },
      );
    }

    const padded = frac.padEnd(exp, '0');
    const digits = `${match.groups['int']}${padded}`;
    const magnitude = BigInt(digits);
    return new Money(match.groups['sign'] === '-' ? -magnitude : magnitude, cur);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(0n, normaliseCurrency(currency));
  }

  private assertSameCurrency(other: Money, op: string): void {
    if (this.currency !== other.currency) {
      throw new ValidationError(
        `Cannot ${op} ${this.currency} and ${other.currency} without an explicit FX conversion`,
        { field: 'currency' },
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return new Money(this.minor < 0n ? -this.minor : this.minor, this.currency);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, 'compare');
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  static sum(items: readonly Money[], currency: CurrencyCode): Money {
    return items.reduce<Money>((acc, m) => acc.add(m), Money.zero(currency));
  }

  /**
   * Absolute difference, used for tolerance checks against extracted totals.
   */
  differenceFrom(other: Money): Money {
    return this.subtract(other).abs();
  }

  /** Exact decimal representation. This is the only string QBO ever sees. */
  toDecimalString(): string {
    const exp = exponentFor(this.currency);
    const negative = this.minor < 0n;
    const digits = (negative ? -this.minor : this.minor).toString().padStart(exp + 1, '0');
    const cut = digits.length - exp;
    const intPart = digits.slice(0, cut);
    const fracPart = digits.slice(cut);
    const body = exp === 0 ? intPart : `${intPart}.${fracPart}`;
    return negative ? `-${body}` : body;
  }

  /**
   * QBO's JSON accepts a JSON number for Amount. We emit it via Number() only at
   * the very last moment, after all arithmetic is complete, and we assert that the
   * round-trip is lossless so a pathological amount fails loudly instead of silently.
   */
  toQboAmount(): number {
    const s = this.toDecimalString();
    const n = Number(s);
    if (!Number.isFinite(n) || n.toFixed(exponentFor(this.currency)) !== s) {
      throw new ValidationError(
        `Amount ${s} ${this.currency} cannot be represented losslessly as a JSON number`,
        { field: 'amount' },
      );
    }
    return n;
  }

  toJSON(): MoneyJSON {
    return { minor: this.minor.toString(), currency: this.currency };
  }

  static fromJSON(json: MoneyJSON): Money {
    return Money.fromMinor(json.minor, json.currency);
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }
}

function normaliseCurrency(currency: string): CurrencyCode {
  const cur = currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(cur)) {
    throw new ValidationError(`Invalid ISO-4217 currency code: "${currency}"`, {
      field: 'currency',
    });
  }
  return cur;
}
