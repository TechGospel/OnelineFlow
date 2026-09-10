import { describe, expect, it } from 'vitest';
import { ValidationError, type ExtractedInvoice } from '@onelineflow/core';
import {
  assertPlausibleRate,
  classifyDocument,
  mapToVendorCredit,
  QboExchangeRateProvider,
} from './credit-note.js';

function doc(overrides: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
  return {
    vendorName: 'Acme Ltd',
    invoiceNumber: 'INV-001',
    invoiceDate: '2026-01-15',
    currency: 'USD',
    total: '500.00',
    lineItems: [{ description: 'Widgets', amount: '500.00', confidence: 0.99 }],
    fieldConfidence: { total: 0.99 },
    ...overrides,
  };
}

describe('document classification', () => {
  it('treats an ordinary positive invoice as a bill', () => {
    expect(classifyDocument(doc()).kind).toBe('bill');
  });

  it('treats a negative total as a vendor credit', () => {
    const result = classifyDocument(
      doc({
        total: '-500.00',
        lineItems: [{ description: 'x', amount: '-500.00', confidence: 1 }],
      }),
    );
    expect(result.kind).toBe('vendor_credit');
  });

  it('warns when a negative total carries no credit-note wording', () => {
    const result = classifyDocument(doc({ total: '-500.00' }));
    expect(result.findings.some((f) => f.code === 'NEGATIVE_TOTAL_NO_CREDIT_MARKER')).toBe(true);
  });

  it('does not warn when the wording confirms it', () => {
    const result = classifyDocument(doc({ total: '-500.00', invoiceNumber: 'CREDIT NOTE CN-9' }));
    expect(result.kind).toBe('vendor_credit');
    expect(result.findings.some((f) => f.code === 'NEGATIVE_TOTAL_NO_CREDIT_MARKER')).toBe(false);
  });

  it('blocks a positive total that reads as a credit note', () => {
    // Genuinely ambiguous — many vendors issue credit notes with positive
    // amounts. Guessing posts money in the wrong direction.
    const result = classifyDocument(doc({ invoiceNumber: 'CREDIT-MEMO-4' }));
    expect(result.kind).toBe('bill');
    expect(
      result.findings.some((f) => f.code === 'AMBIGUOUS_CREDIT_NOTE' && f.severity === 'blocking'),
    ).toBe(true);
  });

  it('does not misread "credit card processing fee" as a credit note', () => {
    // A word-boundary match on "credit" alone would classify a perfectly
    // ordinary bill as a credit and reverse the posting.
    const result = classifyDocument(
      doc({
        lineItems: [{ description: 'Credit card processing fee', amount: '500.00', confidence: 1 }],
      }),
    );
    expect(result.kind).toBe('bill');
    expect(result.findings).toHaveLength(0);
  });
});

describe('mapToVendorCredit', () => {
  const base = {
    vendorRef: { value: '42' },
    lineAccountRefs: [{ value: '7' }],
    privateNote: 'onelineFlow test',
    homeCurrency: 'USD',
  };

  it('emits POSITIVE amounts', () => {
    // QuickBooks derives the sign from the entity type. Negative lines on a
    // VendorCredit double-negate and increase what you owe.
    const { credit } = mapToVendorCredit({
      ...base,
      extracted: doc({
        total: '-500.00',
        lineItems: [{ description: 'Returned goods', amount: '-500.00', confidence: 1 }],
      }),
    });
    expect(credit.Line[0]?.Amount).toBe(500);
  });

  it('enforces the arithmetic invariant on absolute values', () => {
    expect(() =>
      mapToVendorCredit({
        ...base,
        extracted: doc({
          total: '-500.00',
          lineItems: [{ description: 'x', amount: '-300.00', confidence: 1 }],
        }),
      }),
    ).toThrow(ValidationError);
  });

  it('accepts net lines plus tax', () => {
    const { findings } = mapToVendorCredit({
      ...base,
      lineAccountRefs: [{ value: '7' }],
      extracted: doc({
        total: '-600.00',
        taxTotal: '-100.00',
        lineItems: [{ description: 'x', amount: '-500.00', confidence: 1 }],
      }),
    });
    expect(findings.some((f) => f.code === 'LINES_NET_OF_TAX')).toBe(true);
  });

  it('refuses a zero-value credit', () => {
    expect(() =>
      mapToVendorCredit({
        ...base,
        extracted: doc({
          total: '0.00',
          lineItems: [{ description: 'x', amount: '0.00', confidence: 1 }],
        }),
      }),
    ).toThrow(/zero-value/);
  });

  it('sets CurrencyRef only for a foreign currency', () => {
    const home = mapToVendorCredit({
      ...base,
      extracted: doc({
        total: '-500.00',
        lineItems: [{ description: 'x', amount: '-500.00', confidence: 1 }],
      }),
    });
    expect(home.credit.CurrencyRef).toBeUndefined();

    const foreign = mapToVendorCredit({
      ...base,
      homeCurrency: 'GBP',
      extracted: doc({
        total: '-500.00',
        lineItems: [{ description: 'x', amount: '-500.00', confidence: 1 }],
      }),
    });
    expect(foreign.credit.CurrencyRef?.value).toBe('USD');
  });
});

describe('exchange rates', () => {
  it('returns 1 for an identity conversion without calling out', async () => {
    let calls = 0;
    const provider = new QboExchangeRateProvider(() => {
      calls += 1;
      return Promise.resolve(2);
    });
    expect(await provider.rate('USD', 'USD', '2026-01-01')).toBe(1);
    expect(calls).toBe(0);
  });

  it('caches within the TTL', async () => {
    let calls = 0;
    const provider = new QboExchangeRateProvider(() => {
      calls += 1;
      return Promise.resolve(1.27);
    });
    await provider.rate('GBP', 'USD', '2026-01-01');
    await provider.rate('GBP', 'USD', '2026-01-01');
    expect(calls).toBe(1);
  });

  it('does not cache across different dates', async () => {
    let calls = 0;
    const provider = new QboExchangeRateProvider(() => {
      calls += 1;
      return Promise.resolve(1.27);
    });
    await provider.rate('GBP', 'USD', '2026-01-01');
    await provider.rate('GBP', 'USD', '2026-01-02');
    expect(calls).toBe(2);
  });

  it('returns null when no rate is available rather than guessing', async () => {
    const provider = new QboExchangeRateProvider(() => Promise.resolve(null));
    expect(await provider.rate('GBP', 'USD', '2026-01-01')).toBeNull();
  });

  it('refuses a zero or negative rate', async () => {
    const provider = new QboExchangeRateProvider(() => Promise.resolve(0));
    // A zero rate would silently zero out a payable.
    await expect(provider.rate('GBP', 'USD', '2026-01-01')).rejects.toThrow(ValidationError);
  });
});

describe('assertPlausibleRate', () => {
  it('accepts ordinary rates', () => {
    expect(() => assertPlausibleRate(1.27, 'GBP', 'USD')).not.toThrow();
    expect(() => assertPlausibleRate(157.3, 'USD', 'JPY')).not.toThrow();
    expect(() => assertPlausibleRate(0.0064, 'JPY', 'USD')).not.toThrow();
  });

  it('rejects an order-of-magnitude error', () => {
    // The failure this catches: a provider returning an inverted rate posts a
    // bill for a tiny fraction of its real value.
    expect(() => assertPlausibleRate(1e-9, 'USD', 'JPY')).toThrow(/inverted/);
    expect(() => assertPlausibleRate(1e9, 'USD', 'JPY')).toThrow(/inverted/);
  });

  it('rejects non-numbers and non-positives', () => {
    expect(() => assertPlausibleRate(Number.NaN, 'A', 'B')).toThrow();
    expect(() => assertPlausibleRate(0, 'A', 'B')).toThrow();
    expect(() => assertPlausibleRate(-1, 'A', 'B')).toThrow();
  });
});
