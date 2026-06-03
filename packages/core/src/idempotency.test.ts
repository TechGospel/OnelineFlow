import { describe, expect, it } from 'vitest';
import { businessDuplicateKey, documentFingerprint, qboRequestId } from './idempotency.js';
import type { InvoiceId, TenantId } from './ids.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111' as TenantId;
const TENANT_B = '22222222-2222-4222-8222-222222222222' as TenantId;
const INVOICE = 'aaaaaaaa-0000-4000-8000-000000000001' as InvoiceId;

describe('qboRequestId', () => {
  it('is deterministic — the whole point under retry', () => {
    // A retry after a crash MUST reuse the key, or Intuit's server-side
    // deduplication cannot protect us.
    expect(qboRequestId(TENANT_A, INVOICE, 'create-bill')).toBe(
      qboRequestId(TENANT_A, INVOICE, 'create-bill'),
    );
  });

  it('fits inside Intuit’s 50-character limit', () => {
    expect(qboRequestId(TENANT_A, INVOICE, 'create-bill').length).toBeLessThanOrEqual(50);
  });

  it('differs across tenants for the same invoice id', () => {
    expect(qboRequestId(TENANT_A, INVOICE, 'create-bill')).not.toBe(
      qboRequestId(TENANT_B, INVOICE, 'create-bill'),
    );
  });

  it('differs across operations', () => {
    expect(qboRequestId(TENANT_A, INVOICE, 'create-bill')).not.toBe(
      qboRequestId(TENANT_A, INVOICE, 'update-bill'),
    );
  });

  it('changes only when the attempt epoch is deliberately bumped', () => {
    const base = qboRequestId(TENANT_A, INVOICE, 'create-bill', 0);
    expect(qboRequestId(TENANT_A, INVOICE, 'create-bill', 0)).toBe(base);
    expect(qboRequestId(TENANT_A, INVOICE, 'create-bill', 1)).not.toBe(base);
  });
});

describe('documentFingerprint', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 invoice');

  it('is stable for identical content', () => {
    expect(documentFingerprint(TENANT_A, bytes)).toBe(documentFingerprint(TENANT_A, bytes));
  });

  it('is scoped per tenant so two tenants can hold the same document', () => {
    expect(documentFingerprint(TENANT_A, bytes)).not.toBe(documentFingerprint(TENANT_B, bytes));
  });

  it('changes with a single altered byte', () => {
    const altered = new TextEncoder().encode('%PDF-1.4 invoicf');
    expect(documentFingerprint(TENANT_A, bytes)).not.toBe(documentFingerprint(TENANT_A, altered));
  });
});

describe('businessDuplicateKey', () => {
  it('normalises casing, spacing and punctuation in the invoice number', () => {
    const a = businessDuplicateKey(TENANT_A, 'Acme Ltd', 'INV-001', 10000n, 'USD');
    const b = businessDuplicateKey(TENANT_A, 'ACME  LTD.', 'inv 001', 10000n, 'USD');
    expect(a).toBe(b);
  });

  it('folds accents so "Café" and "Cafe" collide', () => {
    const a = businessDuplicateKey(TENANT_A, 'Café Bar', 'INV-1', 100n, 'EUR');
    const b = businessDuplicateKey(TENANT_A, 'Cafe Bar', 'INV-1', 100n, 'EUR');
    expect(a).toBe(b);
  });

  it('distinguishes the same number at a different amount', () => {
    // A vendor legitimately reusing a number for a different bill must not be
    // swallowed as a duplicate.
    const a = businessDuplicateKey(TENANT_A, 'Acme', 'INV-001', 10000n, 'USD');
    const b = businessDuplicateKey(TENANT_A, 'Acme', 'INV-001', 20000n, 'USD');
    expect(a).not.toBe(b);
  });

  it('distinguishes the same amount in a different currency', () => {
    const a = businessDuplicateKey(TENANT_A, 'Acme', 'INV-001', 10000n, 'USD');
    const b = businessDuplicateKey(TENANT_A, 'Acme', 'INV-001', 10000n, 'EUR');
    expect(a).not.toBe(b);
  });

  it('is scoped per tenant', () => {
    const a = businessDuplicateKey(TENANT_A, 'Acme', 'INV-001', 10000n, 'USD');
    const b = businessDuplicateKey(TENANT_B, 'Acme', 'INV-001', 10000n, 'USD');
    expect(a).not.toBe(b);
  });
});
