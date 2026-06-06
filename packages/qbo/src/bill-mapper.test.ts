import { describe, expect, it } from 'vitest';
import { ValidationError, type ExtractedInvoice } from '@onelineflow/core';
import { mapToBill } from './bill-mapper.js';

function extracted(overrides: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
  return {
    vendorName: 'Acme Ltd',
    invoiceNumber: 'INV-001',
    invoiceDate: '2026-01-15',
    dueDate: '2026-02-14',
    currency: 'USD',
    total: '1000.00',
    lineItems: [
      { description: 'Widgets', amount: '600.00', confidence: 0.99 },
      { description: 'Gadgets', amount: '400.00', confidence: 0.99 },
    ],
    fieldConfidence: { total: 0.99 },
    ...overrides,
  };
}

const baseInput = {
  vendorRef: { value: '42', name: 'Acme Ltd' },
  lineAccountRefs: [{ value: '7' }, { value: '8' }],
  privateNote: 'onelineFlow invoice test',
  homeCurrency: 'USD',
};

describe('mapToBill', () => {
  it('maps a well-formed invoice', () => {
    const { bill, findings } = mapToBill({ ...baseInput, extracted: extracted() });
    expect(bill.VendorRef.value).toBe('42');
    expect(bill.Line).toHaveLength(2);
    expect(bill.Line[0]?.Amount).toBe(600);
    expect(bill.TxnDate).toBe('2026-01-15');
    expect(bill.DocNumber).toBe('INV-001');
    expect(findings).toHaveLength(0);
  });

  describe('the arithmetic invariant', () => {
    it('rejects lines that do not sum to the total', () => {
      // QBO would accept this happily and the break would surface weeks later
      // during reconciliation with no trace of its origin.
      expect(() =>
        mapToBill({
          ...baseInput,
          extracted: extracted({ total: '1500.00' }),
        }),
      ).toThrow(ValidationError);
    });

    it('names both figures in the error so a human can act on it', () => {
      try {
        mapToBill({ ...baseInput, extracted: extracted({ total: '1500.00' }) });
        expect.unreachable();
      } catch (err) {
        expect((err as ValidationError).message).toContain('1000.00');
        expect((err as ValidationError).message).toContain('1500.00');
      }
    });

    it('accepts net lines plus a separate tax total', () => {
      const { bill, findings } = mapToBill({
        ...baseInput,
        extracted: extracted({ total: '1200.00', taxTotal: '200.00' }),
      });
      expect(bill.Line).toHaveLength(2);
      expect(findings.some((f) => f.code === 'LINES_NET_OF_TAX')).toBe(true);
    });

    it('still rejects when tax does not reconcile the gap either', () => {
      expect(() =>
        mapToBill({
          ...baseInput,
          extracted: extracted({ total: '1500.00', taxTotal: '200.00' }),
        }),
      ).toThrow(ValidationError);
    });

    it('does not plug a mismatch with a balancing line', () => {
      // A silent plug is how bad data enters a ledger.
      try {
        mapToBill({ ...baseInput, extracted: extracted({ total: '1001.00' }) });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
      }
    });
  });

  it('refuses an empty line list', () => {
    expect(() =>
      mapToBill({
        ...baseInput,
        lineAccountRefs: [],
        extracted: extracted({ lineItems: [], total: '0.00' }),
      }),
    ).toThrow(/no line items/);
  });

  it('refuses a zero or negative total', () => {
    expect(() =>
      mapToBill({
        ...baseInput,
        lineAccountRefs: [{ value: '7' }],
        extracted: extracted({
          total: '-100.00',
          lineItems: [{ description: 'refund', amount: '-100.00', confidence: 0.99 }],
        }),
      }),
    ).toThrow(/non-positive/);
  });

  it('refuses when account refs and lines are misaligned', () => {
    expect(() =>
      mapToBill({ ...baseInput, lineAccountRefs: [{ value: '7' }], extracted: extracted() }),
    ).toThrow(/account refs for 2 lines/);
  });

  describe('DocNumber', () => {
    it('truncates past 21 characters and keeps the distinguishing tail', () => {
      const long = 'PREFIX-2026-ACME-000000012345';
      const { bill, findings } = mapToBill({
        ...baseInput,
        extracted: extracted({ invoiceNumber: long }),
      });
      expect(bill.DocNumber).toHaveLength(21);
      expect(bill.DocNumber).toBe(long.slice(-21));
      expect(findings.some((f) => f.code === 'DOC_NUMBER_TRUNCATED')).toBe(true);
    });

    it('leaves a short number alone', () => {
      const { bill, findings } = mapToBill({ ...baseInput, extracted: extracted() });
      expect(bill.DocNumber).toBe('INV-001');
      expect(findings.some((f) => f.code === 'DOC_NUMBER_TRUNCATED')).toBe(false);
    });
  });

  it('warns when the due date precedes the invoice date', () => {
    const { findings } = mapToBill({
      ...baseInput,
      extracted: extracted({ invoiceDate: '2026-02-01', dueDate: '2026-01-01' }),
    });
    expect(findings.some((f) => f.code === 'DUE_BEFORE_ISSUE')).toBe(true);
  });

  describe('currency', () => {
    it('omits CurrencyRef when the invoice is in the home currency', () => {
      const { bill } = mapToBill({ ...baseInput, extracted: extracted() });
      expect(bill.CurrencyRef).toBeUndefined();
    });

    it('sets CurrencyRef and warns when foreign with no rate supplied', () => {
      const { bill, findings } = mapToBill({
        ...baseInput,
        homeCurrency: 'GBP',
        extracted: extracted(),
      });
      expect(bill.CurrencyRef?.value).toBe('USD');
      expect(findings.some((f) => f.code === 'FX_RATE_DEFAULTED')).toBe(true);
    });

    it('passes an explicit exchange rate through without warning', () => {
      const { bill, findings } = mapToBill({
        ...baseInput,
        homeCurrency: 'GBP',
        exchangeRate: 0.79,
        extracted: extracted(),
      });
      expect(bill.ExchangeRate).toBe(0.79);
      expect(findings.some((f) => f.code === 'FX_RATE_DEFAULTED')).toBe(false);
    });
  });

  it('handles a zero-decimal currency correctly', () => {
    const { bill } = mapToBill({
      ...baseInput,
      homeCurrency: 'JPY',
      lineAccountRefs: [{ value: '7' }],
      extracted: extracted({
        currency: 'JPY',
        total: '150000',
        lineItems: [{ description: 'Parts', amount: '150000', confidence: 0.99 }],
      }),
    });
    expect(bill.Line[0]?.Amount).toBe(150000);
  });

  it('truncates an over-long description rather than failing', () => {
    const { bill } = mapToBill({
      ...baseInput,
      lineAccountRefs: [{ value: '7' }],
      extracted: extracted({
        lineItems: [{ description: 'x'.repeat(5000), amount: '1000.00', confidence: 0.99 }],
      }),
    });
    expect(bill.Line[0]?.Description).toHaveLength(4000);
  });
});
