import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  hasBlockingFinding,
  TERMINAL_STATUSES,
  type InvoiceStatus,
  type ValidationFinding,
} from './invoice.js';
import { ConflictError } from './errors.js';

describe('invoice state machine', () => {
  it('allows the happy path end to end', () => {
    const path: InvoiceStatus[] = [
      'received',
      'extracting',
      'extracted',
      'pending_approval',
      'approved',
      'posting',
      'posted',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  describe('posted is effectively terminal', () => {
    it('only permits voiding', () => {
      expect(canTransition('posted', 'voided')).toBe(true);
    });

    it.each(['approved', 'posting', 'failed', 'needs_review', 'rejected'] as const)(
      'refuses posted -> %s',
      (to) => {
        // Anything that could re-post a bill already in the ledger must be
        // impossible at the type/state level, not merely unlikely.
        expect(canTransition('posted', to)).toBe(false);
      },
    );
  });

  it('allows posting -> approved for crash recovery', () => {
    // A worker that died mid-post leaves `posting`. The reconciler must be able
    // to return it to `approved` once it confirms no bill exists.
    expect(canTransition('posting', 'approved')).toBe(true);
  });

  it('refuses to skip extraction', () => {
    expect(canTransition('received', 'approved')).toBe(false);
    expect(canTransition('received', 'posted')).toBe(false);
  });

  it('refuses to post directly from review', () => {
    expect(canTransition('needs_review', 'posting')).toBe(false);
  });

  it('throws ConflictError with the allowed set attached', () => {
    try {
      assertTransition('posted', 'approved');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).context['allowed']).toEqual(['voided']);
    }
  });

  it('identifies terminal states', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['rejected', 'voided']);
  });

  it('permits recovery out of failed', () => {
    expect(canTransition('failed', 'extracting')).toBe(true);
    expect(canTransition('failed', 'approved')).toBe(true);
  });
});

describe('hasBlockingFinding', () => {
  const finding = (severity: ValidationFinding['severity']): ValidationFinding => ({
    code: 'X',
    severity,
    message: 'm',
  });

  it('is false for an empty list', () => {
    expect(hasBlockingFinding([])).toBe(false);
  });

  it('ignores info and warning', () => {
    expect(hasBlockingFinding([finding('info'), finding('warning')])).toBe(false);
  });

  it('detects a single blocking finding among many', () => {
    expect(hasBlockingFinding([finding('info'), finding('blocking'), finding('warning')])).toBe(
      true,
    );
  });
});
