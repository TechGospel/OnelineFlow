/**
 * Vendor credits and foreign-exchange handling.
 *
 * A credit note is not "a bill with a negative total". QuickBooks models it as a
 * distinct entity (`VendorCredit`), it posts to the opposite side of the ledger,
 * and it settles against outstanding bills rather than creating a payable.
 * Sending a negative Bill instead produces a record that reconciles to the right
 * number and means the wrong thing — which an auditor will find and a
 * reconciliation report will not.
 */

import {
  Money,
  ValidationError,
  type ExtractedInvoice,
  type ValidationFinding,
} from '@onelineflow/core';
import type { QboBillLine, QboRef } from './bill-mapper.js';

export type DocumentKind = 'bill' | 'vendor_credit';

/**
 * Decide whether an extracted document is a bill or a credit note.
 *
 * Deliberately conservative: a negative total is treated as decisive, but text
 * cues alone are not. "Credit" appears in plenty of legitimate bill line items
 * ("credit card processing fee"), and misclassifying a payable as a credit posts
 * money the wrong way round.
 */
export function classifyDocument(extracted: ExtractedInvoice): {
  kind: DocumentKind;
  findings: ValidationFinding[];
} {
  const findings: ValidationFinding[] = [];
  const total = Money.fromDecimalString(extracted.total, extracted.currency);

  // Separator class allows the forms vendors actually use: "CREDIT NOTE",
  // "CREDIT-MEMO", "credit_note", "CreditNote". Still specific enough that
  // "credit card processing fee" does not match, because the second word must
  // be note/memo.
  const CREDIT_MARKERS = /\b(credit[\s._-]*(?:note|memo)|vendor[\s._-]*credit|refund|rma)\b/i;
  const textSuggestsCredit =
    CREDIT_MARKERS.test(extracted.invoiceNumber) ||
    extracted.lineItems.some((l) => CREDIT_MARKERS.test(l.description));

  if (total.minor < 0n) {
    if (!textSuggestsCredit) {
      findings.push({
        code: 'NEGATIVE_TOTAL_NO_CREDIT_MARKER',
        severity: 'warning',
        message:
          'Total is negative but nothing on the document identifies it as a credit note. ' +
          'Treating it as a vendor credit.',
        field: 'total',
      });
    }
    return { kind: 'vendor_credit', findings };
  }

  if (textSuggestsCredit) {
    // Positive total plus credit wording is genuinely ambiguous — many vendors
    // issue credit notes with positive amounts and rely on the document type.
    // A human decides; guessing here posts money in the wrong direction.
    findings.push({
      code: 'AMBIGUOUS_CREDIT_NOTE',
      severity: 'blocking',
      message:
        'The document reads as a credit note but the total is positive. ' +
        'Confirm whether this is a payable or a credit before posting.',
      field: 'total',
    });
  }

  return { kind: 'bill', findings };
}

export interface QboVendorCredit {
  readonly VendorRef: QboRef;
  readonly Line: readonly QboBillLine[];
  readonly TxnDate?: string;
  readonly DocNumber?: string;
  readonly PrivateNote?: string;
  readonly CurrencyRef?: QboRef;
  readonly ExchangeRate?: number;
}

export interface CreditMappingInput {
  readonly extracted: ExtractedInvoice;
  readonly vendorRef: QboRef;
  readonly lineAccountRefs: readonly QboRef[];
  readonly privateNote: string;
  readonly homeCurrency: string;
  readonly exchangeRate?: number;
}

/**
 * Map an extracted credit note to a QBO VendorCredit.
 *
 * Amounts are emitted as POSITIVE values. QuickBooks derives the sign from the
 * entity type: a VendorCredit with negative lines would double-negate and
 * increase what you owe.
 */
export function mapToVendorCredit(input: CreditMappingInput): {
  credit: QboVendorCredit;
  findings: readonly ValidationFinding[];
} {
  const e = input.extracted;
  const findings: ValidationFinding[] = [];

  if (e.lineItems.length === 0) {
    throw new ValidationError('Cannot post a vendor credit with no line items', {
      publicMessage: 'No line items were found on this credit note.',
      field: 'lineItems',
    });
  }
  if (input.lineAccountRefs.length !== e.lineItems.length) {
    throw new ValidationError(
      `Resolved ${input.lineAccountRefs.length} account refs for ${e.lineItems.length} lines`,
    );
  }

  const total = Money.fromDecimalString(e.total, e.currency).abs();
  const lineAmounts = e.lineItems.map((l) => Money.fromDecimalString(l.amount, e.currency).abs());
  const lineSum = Money.sum(lineAmounts, e.currency);

  // Same invariant as a bill, applied to absolute values. A credit whose lines
  // do not sum to its total is as wrong as a bill that does not.
  if (!lineSum.equals(total)) {
    const taxTotal = e.taxTotal ? Money.fromDecimalString(e.taxTotal, e.currency).abs() : null;
    if (taxTotal && lineSum.add(taxTotal).equals(total)) {
      findings.push({
        code: 'LINES_NET_OF_TAX',
        severity: 'info',
        message: `Credit lines ${lineSum.toString()} plus tax ${taxTotal.toString()} equal ${total.toString()}.`,
      });
    } else {
      throw new ValidationError(
        `Credit lines sum to ${lineSum.toString()} but the total is ${total.toString()}`,
        {
          publicMessage:
            `Line items add up to ${lineSum.toDecimalString()} but the credit total says ` +
            `${total.toDecimalString()}. Please review.`,
          field: 'total',
        },
      );
    }
  }

  if (total.isZero()) {
    throw new ValidationError('Refusing to post a zero-value vendor credit', {
      publicMessage: 'This credit note has no value.',
      field: 'total',
    });
  }

  const lines: QboBillLine[] = e.lineItems.map((item, idx) => {
    const accountRef = input.lineAccountRefs[idx];
    /* istanbul ignore next -- length equality checked above */
    if (!accountRef) throw new ValidationError(`Missing account ref for line ${idx}`);
    const amount = lineAmounts[idx];
    /* istanbul ignore next -- built from the same array */
    if (!amount) throw new ValidationError(`Missing amount for line ${idx}`);

    return {
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: amount.toQboAmount(),
      ...(item.description ? { Description: item.description.slice(0, 4000) } : {}),
      AccountBasedExpenseLineDetail: {
        AccountRef: accountRef,
        BillableStatus: 'NotBillable',
      },
    };
  });

  const foreign = e.currency !== input.homeCurrency;
  let docNumber = e.invoiceNumber.trim();
  if (docNumber.length > 21) docNumber = docNumber.slice(-21);

  return {
    credit: {
      VendorRef: input.vendorRef,
      Line: lines,
      TxnDate: e.invoiceDate,
      DocNumber: docNumber,
      PrivateNote: input.privateNote.slice(0, 4000),
      ...(foreign ? { CurrencyRef: { value: e.currency } } : {}),
      ...(foreign && input.exchangeRate !== undefined ? { ExchangeRate: input.exchangeRate } : {}),
    },
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* Foreign exchange                                                    */
/* ------------------------------------------------------------------ */

export interface ExchangeRateProvider {
  /**
   * Rate to convert ONE unit of `from` into `to`, on `asOf`.
   *
   * Returns null when no rate is available; the caller then lets QuickBooks
   * apply its own, which is recorded as a finding so the difference is visible.
   */
  rate(from: string, to: string, asOf: string): Promise<number | null>;
}

/**
 * Rates read from QuickBooks itself.
 *
 * Using QBO's own rates rather than a third-party feed is deliberate: the goal
 * is a ledger that reconciles, not the most accurate rate. A rate that differs
 * from the one QuickBooks would have applied creates an FX variance line that
 * someone has to explain every month.
 */
export class QboExchangeRateProvider implements ExchangeRateProvider {
  private readonly cache = new Map<string, { rate: number; fetchedAt: number }>();

  constructor(
    private readonly fetchRate: (from: string, to: string, asOf: string) => Promise<number | null>,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
  ) {}

  async rate(from: string, to: string, asOf: string): Promise<number | null> {
    if (from === to) return 1;

    const key = `${from}:${to}:${asOf}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < this.ttlMs) return hit.rate;

    const fetched = await this.fetchRate(from, to, asOf);
    if (fetched === null) return null;

    if (!Number.isFinite(fetched) || fetched <= 0) {
      // A zero or negative rate would silently zero out a payable.
      throw new ValidationError(`Refusing an implausible exchange rate ${fetched} for ${key}`);
    }

    this.cache.set(key, { rate: fetched, fetchedAt: Date.now() });
    return fetched;
  }

  /** Test/ops hook. */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Sanity-check a rate before it reaches a ledger.
 *
 * Guards against a provider returning an inverted rate — 0.0079 instead of 127
 * for USD/JPY — which posts a bill for a hundredth of its value. Bounds are
 * deliberately wide; this catches order-of-magnitude errors, not small drift.
 */
export function assertPlausibleRate(rate: number, from: string, to: string): void {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new ValidationError(`Exchange rate ${from}->${to} is not a positive number: ${rate}`);
  }
  if (rate < 1e-6 || rate > 1e6) {
    throw new ValidationError(
      `Exchange rate ${from}->${to} of ${rate} is outside plausible bounds; ` +
        'this usually means the rate is inverted.',
    );
  }
}
