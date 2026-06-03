/**
 * The invoice lifecycle and its state machine.
 *
 * Every transition is explicit and validated. An invoice that reaches POSTED
 * carries an immutable `qboEntityId`; nothing may transition out of POSTED except
 * to VOIDED, and only via an explicit reversal that writes its own audit row.
 */

import { z } from 'zod';
import { ConflictError } from './errors.js';

export const InvoiceStatus = {
  /** Row exists, document bytes are in object storage, nothing parsed yet. */
  RECEIVED: 'received',
  EXTRACTING: 'extracting',
  /** Extraction produced fields, awaiting deterministic validation. */
  EXTRACTED: 'extracted',
  /** Confidence below the auto-post threshold, or models disagreed. */
  NEEDS_REVIEW: 'needs_review',
  /** Passed validation, waiting on the tenant's approval matrix. */
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  /** Handed to the posting worker; a QBO write may be in flight. */
  POSTING: 'posting',
  POSTED: 'posted',
  /** Permanent failure. Requires human intervention, will not auto-retry. */
  FAILED: 'failed',
  REJECTED: 'rejected',
  VOIDED: 'voided',
} as const;

// Deliberate value/type pairing: `InvoiceStatus.POSTED` for the value and
// `InvoiceStatus` for the union type. Not a redeclaration — separate namespaces.
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

/**
 * Adjacency list for the state machine. Absent key => terminal state.
 *
 * Note POSTING -> APPROVED: that is the recovery path when a worker crashes
 * before it learns the outcome. The reconciler moves the invoice back only after
 * confirming with QBO that no bill exists for its idempotency key.
 */
const TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = Object.freeze({
  received: ['extracting', 'failed'],
  extracting: ['extracted', 'needs_review', 'failed'],
  extracted: ['pending_approval', 'needs_review', 'failed'],
  needs_review: ['pending_approval', 'approved', 'rejected', 'extracting'],
  pending_approval: ['approved', 'rejected', 'needs_review'],
  approved: ['posting', 'rejected', 'needs_review'],
  posting: ['posted', 'failed', 'approved'],
  posted: ['voided'],
  failed: ['extracting', 'needs_review', 'approved', 'rejected'],
  rejected: [],
  voided: [],
});

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`Illegal invoice transition ${from} -> ${to}`, {
      publicMessage: 'This invoice cannot move to that state from its current state.',
      context: { from, to, allowed: TRANSITIONS[from] },
    });
  }
}

export const TERMINAL_STATUSES: readonly InvoiceStatus[] = Object.freeze(
  (Object.keys(TRANSITIONS) as InvoiceStatus[]).filter((s) => TRANSITIONS[s].length === 0),
);

/* ------------------------------------------------------------------ */
/* Extraction payload                                                  */
/* ------------------------------------------------------------------ */

/** Per-field confidence in [0,1], produced by the extraction consensus step. */
export const confidenceSchema = z.number().min(0).max(1);

export const extractedLineItemSchema = z.object({
  description: z.string().min(1).max(1000),
  /** Decimal string, validated into Money downstream. Never a float here. */
  amount: z.string().regex(/^-?\d+(\.\d+)?$/),
  quantity: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .optional(),
  unitPrice: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .optional(),
  glCode: z.string().max(64).optional(),
  taxCode: z.string().max(64).optional(),
  confidence: confidenceSchema,
});

export type ExtractedLineItem = z.infer<typeof extractedLineItemSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const extractedInvoiceSchema = z.object({
  vendorName: z.string().min(1).max(500),
  vendorTaxId: z.string().max(64).optional(),
  invoiceNumber: z.string().min(1).max(128),
  invoiceDate: isoDate,
  dueDate: isoDate.optional(),
  poNumber: z.string().max(128).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  subtotal: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .optional(),
  taxTotal: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .optional(),
  total: z.string().regex(/^-?\d+(\.\d+)?$/),
  lineItems: z.array(extractedLineItemSchema).max(500),
  /** Per-field confidences keyed by the field name above. */
  fieldConfidence: z.record(z.string(), confidenceSchema),
});

export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;

/* ------------------------------------------------------------------ */
/* Validation findings                                                 */
/* ------------------------------------------------------------------ */

export type FindingSeverity = 'info' | 'warning' | 'blocking';

export interface ValidationFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly field?: string;
}

export function hasBlockingFinding(findings: readonly ValidationFinding[]): boolean {
  return findings.some((f) => f.severity === 'blocking');
}
