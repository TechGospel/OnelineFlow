import { describe, expect, it } from 'vitest';
import { ValidationError, asTenantId } from '@onelineflow/core';
import { documentKey } from './document-store.js';

const TENANT_A = asTenantId('11111111-1111-4111-8111-111111111111');
const TENANT_B = asTenantId('22222222-2222-4222-8222-222222222222');
const FP = 'a'.repeat(64);

describe('documentKey', () => {
  it('prefixes with the tenant so keys are scopeable by bucket policy', () => {
    expect(documentKey(TENANT_A, FP).startsWith(`${TENANT_A}/`)).toBe(true);
  });

  it('shards on the first two hex characters', () => {
    // A flat tenant/<hash> layout concentrates millions of objects on one
    // internal partition in some object stores.
    expect(documentKey(TENANT_A, FP)).toBe(`${TENANT_A}/aa/${FP}`);
  });

  it('is deterministic — the same content yields the same key', () => {
    expect(documentKey(TENANT_A, FP)).toBe(documentKey(TENANT_A, FP));
  });

  it('separates tenants holding byte-identical documents', () => {
    expect(documentKey(TENANT_A, FP)).not.toBe(documentKey(TENANT_B, FP));
  });

  it('rejects anything that is not a sha256 hex digest', () => {
    expect(() => documentKey(TENANT_A, 'short')).toThrow(ValidationError);
    expect(() => documentKey(TENANT_A, 'g'.repeat(64))).toThrow(ValidationError);
    expect(() => documentKey(TENANT_A, FP.toUpperCase())).toThrow(ValidationError);
  });

  it('cannot be coerced into escaping the tenant prefix', () => {
    // The fingerprint reaches an object key. A traversal-shaped value must be
    // rejected by the format check rather than sanitised.
    expect(() => documentKey(TENANT_A, '../../etc/passwd')).toThrow(ValidationError);
  });
});
