import { describe, expect, it } from 'vitest';
import { ALLOWED_ALGORITHMS, PUBLIC_PATHS, parseBearerToken } from './jwt-auth.js';
import { contextFromClaims } from '../auth.js';
import { AuthError } from '@onelineflow/core';
import type { FastifyRequest } from 'fastify';

const req = (authorization?: string): FastifyRequest =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as FastifyRequest;

describe('bearer token parsing', () => {
  it('extracts a well-formed token', () => {
    expect(parseBearerToken(req('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it('accepts a case-insensitive scheme', () => {
    expect(parseBearerToken(req('bearer abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it('returns null when the header is absent', () => {
    expect(parseBearerToken(req())).toBeNull();
  });

  it('rejects a non-bearer scheme', () => {
    // Basic auth against this API would be a credential in a header on every
    // request; it is not supported and must not silently fall through.
    expect(parseBearerToken(req('Basic dXNlcjpwYXNz'))).toBeNull();
  });

  it('rejects an empty credential', () => {
    expect(parseBearerToken(req('Bearer '))).toBeNull();
    expect(parseBearerToken(req('Bearer'))).toBeNull();
  });

  it('rejects characters outside the JWT alphabet', () => {
    expect(parseBearerToken(req('Bearer abc def'))).toBeNull();
    expect(parseBearerToken(req('Bearer <script>'))).toBeNull();
  });
});

describe('algorithm allow-list', () => {
  it('permits only asymmetric algorithms', () => {
    // The alg-confusion attack swaps RS256 for HS256 so the PUBLIC key is used
    // as an HMAC secret, letting anyone who can read it mint valid tokens.
    for (const alg of ALLOWED_ALGORITHMS) {
      expect(alg.startsWith('HS')).toBe(false);
    }
  });

  it('excludes "none"', () => {
    expect(ALLOWED_ALGORITHMS).not.toContain('none');
    expect(ALLOWED_ALGORITHMS).not.toContain('None');
  });

  it('is non-empty — an empty list would accept anything jose defaults to', () => {
    expect(ALLOWED_ALGORITHMS.length).toBeGreaterThan(0);
  });
});

describe('public paths', () => {
  it('exempts only health, metrics, the OAuth callback and the webhook', () => {
    expect([...PUBLIC_PATHS].sort()).toEqual([
      '/healthz',
      '/metrics',
      '/readyz',
      '/v1/qbo/callback',
      '/v1/webhooks/intuit',
    ]);
  });

  it('does not exempt any invoice route', () => {
    // Ingestion and approval must never be reachable unauthenticated.
    for (const p of PUBLIC_PATHS) {
      expect(p.startsWith('/v1/invoices')).toBe(false);
    }
  });
});

describe('contextFromClaims', () => {
  const valid = {
    sub: 'bbbbbbbb-0000-4000-8000-000000000002',
    tenant_id: '11111111-1111-4111-8111-111111111111',
    role: 'approver',
  };

  it('builds a context from complete claims', () => {
    const ctx = contextFromClaims(valid);
    expect(ctx.role).toBe('approver');
    expect(ctx.tenantId).toBe(valid.tenant_id);
  });

  it('rejects a missing tenant claim', () => {
    const { tenant_id: _omitted, ...rest } = valid;
    expect(() => contextFromClaims(rest)).toThrow(AuthError);
  });

  it('rejects an unknown role rather than defaulting', () => {
    // Defaulting an unrecognised role to 'viewer' would silently grant access
    // to a token asserting something we do not understand.
    expect(() => contextFromClaims({ ...valid, role: 'superuser' })).toThrow(AuthError);
  });

  it('parses an approval limit supplied as a string', () => {
    // bigint amounts exceed Number.MAX_SAFE_INTEGER, so IdPs emit them as
    // strings. Both forms must work.
    const ctx = contextFromClaims({ ...valid, approval_limit_minor: '900000000000000000' });
    expect(ctx.approvalLimitMinor).toBe(900000000000000000n);
  });

  it('treats an absent limit as unlimited', () => {
    expect(contextFromClaims(valid).approvalLimitMinor).toBeNull();
  });
});
