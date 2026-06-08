/**
 * Two-model consensus gate.
 *
 * This is the control that makes AI extraction safe to auto-post. The rule:
 *
 *   Auto-post only if the primary model is confident AND — where a second
 *   opinion was taken — both models agree exactly on the fields that move money.
 *
 * "Exactly" is deliberate for money and identifiers. A 1-cent disagreement on a
 * total is not a rounding nuance; it means at least one model misread a digit,
 * and there is no way to know which. Human review costs a minute. A wrong bill
 * in a general ledger costs an audit finding.
 *
 * Cost control: the second model runs only when the first is below
 * `consensusTriggerThreshold`. In steady state the large majority of invoices
 * are clean scans from repeat vendors, so the second call is rare — the safety
 * is nearly free.
 */

import type { ExtractedInvoice, ValidationFinding } from '@onelineflow/core';
import { Money } from '@onelineflow/core';
import type { ExtractionResult } from './provider.js';

/** Fields where any disagreement blocks auto-posting. */
const CRITICAL_FIELDS = ['total', 'invoiceNumber', 'currency'] as const;
/** Fields where disagreement is a warning, not a block. */
const ADVISORY_FIELDS = ['vendorName', 'invoiceDate', 'dueDate', 'taxTotal'] as const;

export interface ConsensusOptions {
  readonly autopostThreshold: number;
  readonly consensusTriggerThreshold: number;
}

export interface ConsensusOutcome {
  readonly extracted: ExtractedInvoice;
  readonly overallConfidence: number;
  readonly models: readonly string[];
  readonly costMicros: bigint;
  readonly agreed: boolean;
  readonly requiresReview: boolean;
  readonly findings: readonly ValidationFinding[];
}

/**
 * Overall confidence is the MINIMUM per-field confidence over the critical
 * fields, not the mean.
 *
 * A mean lets nine confident fields hide one unreadable total — precisely the
 * case that must not auto-post. The weakest critical link is the honest number.
 */
export function overallConfidence(extracted: ExtractedInvoice): number {
  const fc = extracted.fieldConfidence;
  const criticals = CRITICAL_FIELDS.map((f) => fc[f]).filter(
    (v): v is number => typeof v === 'number',
  );
  const lineConfidences = extracted.lineItems.map((l) => l.confidence);
  const all = [...criticals, ...lineConfidences];
  if (all.length === 0) return 0;
  return Math.min(...all);
}

function normaliseForCompare(field: string, value: unknown, currency: string): string | null {
  if (value === undefined || value === null) return null;
  // Fields are strings in the schema, but this reads from an index signature
  // so the type is `unknown`. Anything non-primitive here is a schema bug —
  // surface it as a non-match rather than as "[object Object]".
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value);

  // Money fields compare as canonical minor units so "1234.5" and "1234.50"
  // are correctly treated as equal rather than as a disagreement.
  if (field === 'total' || field === 'taxTotal' || field === 'subtotal') {
    try {
      return Money.fromDecimalString(s, currency).minor.toString();
    } catch {
      return s;
    }
  }
  if (field === 'invoiceNumber' || field === 'vendorName') {
    return s
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }
  return s.trim();
}

export function compareExtractions(
  a: ExtractedInvoice,
  b: ExtractedInvoice,
): { agreed: boolean; findings: ValidationFinding[] } {
  const findings: ValidationFinding[] = [];
  let agreed = true;

  // Currency must match before money comparison is meaningful at all.
  if (a.currency !== b.currency) {
    return {
      agreed: false,
      findings: [
        {
          code: 'CONSENSUS_CURRENCY_MISMATCH',
          severity: 'blocking',
          message: `Models disagree on currency: "${a.currency}" vs "${b.currency}".`,
          field: 'currency',
        },
      ],
    };
  }

  for (const field of CRITICAL_FIELDS) {
    const av = normaliseForCompare(field, a[field], a.currency);
    const bv = normaliseForCompare(field, b[field], b.currency);
    if (av !== bv) {
      agreed = false;
      findings.push({
        code: 'CONSENSUS_MISMATCH',
        severity: 'blocking',
        message: `Models disagree on ${field}: "${String(a[field])}" vs "${String(b[field])}".`,
        field,
      });
    }
  }

  for (const field of ADVISORY_FIELDS) {
    const av = normaliseForCompare(field, a[field], a.currency);
    const bv = normaliseForCompare(field, b[field], b.currency);
    if (av !== bv) {
      findings.push({
        code: 'CONSENSUS_ADVISORY_MISMATCH',
        severity: 'warning',
        message: `Models differ on ${field}: "${String(a[field])}" vs "${String(b[field])}".`,
        field,
      });
    }
  }

  // Line counts differing is not itself blocking — the totals check in the
  // mapper is the real guard — but it is a strong review signal.
  if (a.lineItems.length !== b.lineItems.length) {
    findings.push({
      code: 'CONSENSUS_LINE_COUNT',
      severity: 'warning',
      message: `Line counts differ: ${a.lineItems.length} vs ${b.lineItems.length}.`,
      field: 'lineItems',
    });
  }

  return { agreed, findings };
}

/**
 * Decide the outcome given the primary result and an optional secondary.
 *
 * `secondary` is undefined when the primary cleared the trigger threshold and no
 * second call was made.
 */
export function reachConsensus(
  primary: ExtractionResult,
  secondary: ExtractionResult | undefined,
  opts: ConsensusOptions,
): ConsensusOutcome {
  const primaryConfidence = overallConfidence(primary.extracted);
  const findings: ValidationFinding[] = [];

  if (!secondary) {
    const requiresReview = primaryConfidence < opts.autopostThreshold;
    if (requiresReview) {
      findings.push({
        code: 'LOW_CONFIDENCE',
        severity: 'blocking',
        message:
          `Extraction confidence ${primaryConfidence.toFixed(3)} is below the ` +
          `auto-post threshold ${opts.autopostThreshold}.`,
      });
    }
    return {
      extracted: primary.extracted,
      overallConfidence: primaryConfidence,
      models: [primary.model],
      costMicros: primary.costMicros,
      agreed: true,
      requiresReview,
      findings,
    };
  }

  const secondaryConfidence = overallConfidence(secondary.extracted);
  const comparison = compareExtractions(primary.extracted, secondary.extracted);
  findings.push(...comparison.findings);

  // Confidence when two models were consulted is the lower of the two, further
  // floored to 0 on disagreement. Agreement does not raise confidence above
  // what the weaker model justified — two models can be wrong together.
  const combined = comparison.agreed ? Math.min(primaryConfidence, secondaryConfidence) : 0;

  const requiresReview = !comparison.agreed || combined < opts.autopostThreshold;
  if (requiresReview && comparison.agreed) {
    findings.push({
      code: 'LOW_CONFIDENCE',
      severity: 'blocking',
      message:
        `Both models agree but combined confidence ${combined.toFixed(3)} is below ` +
        `the auto-post threshold ${opts.autopostThreshold}.`,
    });
  }

  return {
    // Keep the primary's payload: mixing fields from two extractions would
    // produce a record that neither model actually asserted.
    extracted: primary.extracted,
    overallConfidence: combined,
    models: [primary.model, secondary.model],
    costMicros: primary.costMicros + secondary.costMicros,
    agreed: comparison.agreed,
    requiresReview,
    findings,
  };
}

/** Whether the primary result is confident enough to skip the second model. */
export function needsSecondOpinion(primary: ExtractionResult, opts: ConsensusOptions): boolean {
  return overallConfidence(primary.extracted) < opts.consensusTriggerThreshold;
}
