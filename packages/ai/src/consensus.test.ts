import { describe, expect, it } from 'vitest';
import type { ExtractedInvoice } from '@onelineflow/core';
import {
  compareExtractions,
  needsSecondOpinion,
  overallConfidence,
  reachConsensus,
} from './consensus.js';
import type { ExtractionResult } from './provider.js';

const OPTS = { autopostThreshold: 0.95, consensusTriggerThreshold: 0.98 };

function invoice(overrides: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
  return {
    vendorName: 'Acme Ltd',
    invoiceNumber: 'INV-001',
    invoiceDate: '2026-01-15',
    currency: 'USD',
    total: '1000.00',
    lineItems: [{ description: 'Widgets', amount: '1000.00', confidence: 0.99 }],
    fieldConfidence: { total: 0.99, invoiceNumber: 0.99, currency: 0.99, vendorName: 0.99 },
    ...overrides,
  };
}

function result(extracted: ExtractedInvoice, model = 'model-a'): ExtractionResult {
  return {
    extracted,
    model,
    provider: 'test',
    latencyMs: 100,
    costMicros: 500n,
    inputTokens: 1000,
    outputTokens: 200,
  };
}

describe('overallConfidence', () => {
  it('is the minimum, not the mean', () => {
    // A mean would let nine confident fields hide one unreadable total.
    const inv = invoice({
      fieldConfidence: { total: 0.4, invoiceNumber: 0.99, currency: 0.99 },
    });
    expect(overallConfidence(inv)).toBe(0.4);
  });

  it('includes line-item confidence in the minimum', () => {
    const inv = invoice({
      lineItems: [{ description: 'x', amount: '1000.00', confidence: 0.3 }],
    });
    expect(overallConfidence(inv)).toBe(0.3);
  });

  it('is zero when nothing is known', () => {
    expect(overallConfidence(invoice({ fieldConfidence: {}, lineItems: [] }))).toBe(0);
  });
});

describe('compareExtractions', () => {
  it('agrees on identical extractions', () => {
    expect(compareExtractions(invoice(), invoice()).agreed).toBe(true);
  });

  it('treats 1000.0 and 1000.00 as the same amount', () => {
    // Formatting is not disagreement.
    const cmp = compareExtractions(invoice({ total: '1000.0' }), invoice({ total: '1000.00' }));
    expect(cmp.agreed).toBe(true);
  });

  it('blocks on a one-cent total difference', () => {
    // Not a rounding nuance: one of the models misread a digit and we cannot
    // know which.
    const cmp = compareExtractions(invoice({ total: '1000.00' }), invoice({ total: '1000.01' }));
    expect(cmp.agreed).toBe(false);
    expect(cmp.findings.some((f) => f.severity === 'blocking' && f.field === 'total')).toBe(true);
  });

  it('blocks on a currency mismatch immediately', () => {
    const cmp = compareExtractions(invoice({ currency: 'USD' }), invoice({ currency: 'EUR' }));
    expect(cmp.agreed).toBe(false);
    expect(cmp.findings[0]?.code).toBe('CONSENSUS_CURRENCY_MISMATCH');
  });

  it('normalises invoice-number formatting before comparing', () => {
    const cmp = compareExtractions(
      invoice({ invoiceNumber: 'INV-001' }),
      invoice({ invoiceNumber: 'inv 001' }),
    );
    expect(cmp.agreed).toBe(true);
  });

  it('treats a vendor-name difference as advisory, not blocking', () => {
    const cmp = compareExtractions(
      invoice({ vendorName: 'Acme Ltd' }),
      invoice({ vendorName: 'Acme Limited' }),
    );
    expect(cmp.agreed).toBe(true);
    expect(cmp.findings.some((f) => f.severity === 'warning')).toBe(true);
  });

  it('warns on differing line counts without blocking', () => {
    const cmp = compareExtractions(
      invoice(),
      invoice({
        lineItems: [
          { description: 'a', amount: '500.00', confidence: 0.99 },
          { description: 'b', amount: '500.00', confidence: 0.99 },
        ],
      }),
    );
    expect(cmp.agreed).toBe(true);
    expect(cmp.findings.some((f) => f.code === 'CONSENSUS_LINE_COUNT')).toBe(true);
  });
});

describe('needsSecondOpinion', () => {
  it('skips the second model when the primary is very confident', () => {
    const high = invoice({
      fieldConfidence: { total: 0.995, invoiceNumber: 0.995, currency: 0.995 },
      lineItems: [{ description: 'x', amount: '1000.00', confidence: 0.995 }],
    });
    expect(needsSecondOpinion(result(high), OPTS)).toBe(false);
  });

  it('escalates when the primary is below the trigger', () => {
    const low = invoice({
      fieldConfidence: { total: 0.9, invoiceNumber: 0.99, currency: 0.99 },
    });
    expect(needsSecondOpinion(result(low), OPTS)).toBe(true);
  });
});

describe('reachConsensus', () => {
  it('auto-posts a single confident extraction', () => {
    const high = invoice({
      fieldConfidence: { total: 0.99, invoiceNumber: 0.99, currency: 0.99 },
      lineItems: [{ description: 'x', amount: '1000.00', confidence: 0.99 }],
    });
    const outcome = reachConsensus(result(high), undefined, OPTS);
    expect(outcome.requiresReview).toBe(false);
    expect(outcome.models).toEqual(['model-a']);
  });

  it('routes a low-confidence single extraction to review', () => {
    const low = invoice({ fieldConfidence: { total: 0.5, invoiceNumber: 0.99, currency: 0.99 } });
    const outcome = reachConsensus(result(low), undefined, OPTS);
    expect(outcome.requiresReview).toBe(true);
    expect(outcome.findings.some((f) => f.code === 'LOW_CONFIDENCE')).toBe(true);
  });

  it('forces review and zero confidence when the models disagree on money', () => {
    const a = invoice({ total: '1000.00' });
    const b = invoice({ total: '9999.00' });
    const outcome = reachConsensus(result(a), result(b, 'model-b'), OPTS);
    expect(outcome.agreed).toBe(false);
    expect(outcome.requiresReview).toBe(true);
    expect(outcome.overallConfidence).toBe(0);
  });

  it('does not let agreement raise confidence above the weaker model', () => {
    // Two models can be confidently wrong together; agreement is not evidence
    // of higher accuracy than the weaker of the two justified.
    const strong = invoice({
      fieldConfidence: { total: 0.99, invoiceNumber: 0.99, currency: 0.99 },
      lineItems: [{ description: 'x', amount: '1000.00', confidence: 0.99 }],
    });
    const weak = invoice({
      fieldConfidence: { total: 0.8, invoiceNumber: 0.99, currency: 0.99 },
      lineItems: [{ description: 'x', amount: '1000.00', confidence: 0.99 }],
    });
    const outcome = reachConsensus(result(strong), result(weak, 'model-b'), OPTS);
    expect(outcome.overallConfidence).toBe(0.8);
    expect(outcome.requiresReview).toBe(true);
  });

  it('keeps the primary payload rather than merging the two', () => {
    const a = invoice({ vendorName: 'Acme Ltd' });
    const b = invoice({ vendorName: 'Acme Limited' });
    const outcome = reachConsensus(result(a), result(b, 'model-b'), OPTS);
    // A merged record would assert something neither model actually said.
    expect(outcome.extracted.vendorName).toBe('Acme Ltd');
  });

  it('sums the cost of both calls', () => {
    const outcome = reachConsensus(result(invoice()), result(invoice(), 'model-b'), OPTS);
    expect(outcome.costMicros).toBe(1000n);
  });
});
