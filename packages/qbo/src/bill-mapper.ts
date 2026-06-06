/**
 * Turning an extracted invoice into a QBO Bill payload.
 *
 * The invariant enforced here: the sum of line amounts must equal the invoice
 * total. QBO will happily accept a Bill whose lines do not add up to what the
 * paper invoice says, and the discrepancy then surfaces weeks later during
 * reconciliation with no trace of where it came from. Better to refuse now.
 */

import {
  Money,
  ValidationError,
  type ExtractedInvoice,
  type ValidationFinding,
} from '@onelineflow/core';

export interface QboRef {
  readonly value: string;
  readonly name?: string;
}

export interface QboBillLine {
  readonly DetailType: 'AccountBasedExpenseLineDetail';
  readonly Amount: number;
  readonly Description?: string;
  readonly AccountBasedExpenseLineDetail: {
    readonly AccountRef: QboRef;
    readonly BillableStatus?: 'Billable' | 'NotBillable';
    readonly TaxCodeRef?: QboRef;
  };
}

export interface QboBill {
  readonly VendorRef: QboRef;
  readonly Line: readonly QboBillLine[];
  readonly TxnDate?: string;
  readonly DueDate?: string;
  readonly DocNumber?: string;
  readonly PrivateNote?: string;
  readonly CurrencyRef?: QboRef;
  readonly ExchangeRate?: number;
}

export interface MappingInput {
  readonly extracted: ExtractedInvoice;
  readonly vendorRef: QboRef;
  /** QBO Account id per line index. Resolution happens before mapping. */
  readonly lineAccountRefs: readonly QboRef[];
  readonly lineTaxRefs?: readonly (QboRef | undefined)[];
  /** Free-text traceability note written into the QBO record. */
  readonly privateNote: string;
  /** Home currency of the QBO company; drives whether CurrencyRef is needed. */
  readonly homeCurrency: string;
  readonly exchangeRate?: number;
}

export interface MappingResult {
  readonly bill: QboBill;
  readonly findings: readonly ValidationFinding[];
}

/**
 * QBO's DocNumber field is limited to 21 characters. A longer vendor invoice
 * number must be truncated, and silently truncating two different numbers to
 * the same 21 chars would create a false duplicate — so we note it as a finding.
 */
const MAX_DOC_NUMBER = 21;

export function mapToBill(input: MappingInput): MappingResult {
  const e = input.extracted;
  const findings: ValidationFinding[] = [];

  if (e.lineItems.length === 0) {
    throw new ValidationError('Cannot post a bill with no line items', {
      publicMessage: 'No line items were found on this invoice.',
      field: 'lineItems',
    });
  }
  if (input.lineAccountRefs.length !== e.lineItems.length) {
    throw new ValidationError(
      `Resolved ${input.lineAccountRefs.length} account refs for ${e.lineItems.length} lines`,
    );
  }

  const total = Money.fromDecimalString(e.total, e.currency);
  const lineAmounts = e.lineItems.map((l) => Money.fromDecimalString(l.amount, e.currency));
  const lineSum = Money.sum(lineAmounts, e.currency);

  // --- The arithmetic invariant -------------------------------------------
  if (!lineSum.equals(total)) {
    const delta = total.differenceFrom(lineSum);
    const taxTotal = e.taxTotal ? Money.fromDecimalString(e.taxTotal, e.currency) : null;

    if (taxTotal && lineSum.add(taxTotal).equals(total)) {
      // Common and benign: lines are net, total is gross. Tax rides on the
      // lines via TaxCodeRef, so the payload is still correct.
      findings.push({
        code: 'LINES_NET_OF_TAX',
        severity: 'info',
        message: `Line sum ${lineSum.toString()} plus tax ${taxTotal.toString()} equals total ${total.toString()}.`,
      });
    } else {
      // Anything else is a genuine mismatch. Refuse rather than plug it with a
      // balancing line — a silent plug is how bad data enters a ledger.
      throw new ValidationError(
        `Line items sum to ${lineSum.toString()} but the invoice total is ${total.toString()} (difference ${delta.toString()})`,
        {
          publicMessage:
            `Line items add up to ${lineSum.toDecimalString()} but the invoice total ` +
            `says ${total.toDecimalString()}. Please review.`,
          field: 'total',
          context: { lineSum: lineSum.toString(), total: total.toString() },
        },
      );
    }
  }

  if (total.minor <= 0n) {
    throw new ValidationError(`Refusing to post a non-positive bill total: ${total.toString()}`, {
      publicMessage: 'The invoice total must be greater than zero. Credit notes post separately.',
      field: 'total',
    });
  }

  // --- DocNumber ------------------------------------------------------------
  let docNumber = e.invoiceNumber.trim();
  if (docNumber.length > MAX_DOC_NUMBER) {
    findings.push({
      code: 'DOC_NUMBER_TRUNCATED',
      severity: 'warning',
      message: `Invoice number "${docNumber}" exceeds QuickBooks' ${MAX_DOC_NUMBER}-character limit and was truncated.`,
      field: 'invoiceNumber',
    });
    // Keep the tail, not the head: suffixes carry the sequence number that
    // actually distinguishes one invoice from the next.
    docNumber = docNumber.slice(-MAX_DOC_NUMBER);
  }

  // --- Dates ----------------------------------------------------------------
  if (e.dueDate && e.dueDate < e.invoiceDate) {
    findings.push({
      code: 'DUE_BEFORE_ISSUE',
      severity: 'warning',
      message: `Due date ${e.dueDate} precedes the invoice date ${e.invoiceDate}.`,
      field: 'dueDate',
    });
  }

  // --- Lines ----------------------------------------------------------------
  const lines: QboBillLine[] = e.lineItems.map((item, idx) => {
    const accountRef = input.lineAccountRefs[idx];
    /* istanbul ignore next -- length equality checked above */
    if (!accountRef) throw new ValidationError(`Missing account ref for line ${idx}`);
    const taxRef = input.lineTaxRefs?.[idx];
    const amount = lineAmounts[idx];
    /* istanbul ignore next -- built from the same array */
    if (!amount) throw new ValidationError(`Missing amount for line ${idx}`);

    return {
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: amount.toQboAmount(),
      // QBO caps Description at 4000 chars.
      ...(item.description ? { Description: item.description.slice(0, 4000) } : {}),
      AccountBasedExpenseLineDetail: {
        AccountRef: accountRef,
        BillableStatus: 'NotBillable',
        ...(taxRef ? { TaxCodeRef: taxRef } : {}),
      },
    };
  });

  // --- Currency -------------------------------------------------------------
  const foreign = e.currency !== input.homeCurrency;
  if (foreign && input.exchangeRate === undefined) {
    findings.push({
      code: 'FX_RATE_DEFAULTED',
      severity: 'warning',
      message:
        `Invoice is in ${e.currency} but the company's home currency is ` +
        `${input.homeCurrency}; QuickBooks will apply its own rate.`,
      field: 'currency',
    });
  }

  const bill: QboBill = {
    VendorRef: input.vendorRef,
    Line: lines,
    TxnDate: e.invoiceDate,
    ...(e.dueDate ? { DueDate: e.dueDate } : {}),
    DocNumber: docNumber,
    PrivateNote: input.privateNote.slice(0, 4000),
    ...(foreign ? { CurrencyRef: { value: e.currency } } : {}),
    ...(foreign && input.exchangeRate !== undefined ? { ExchangeRate: input.exchangeRate } : {}),
  };

  return { bill, findings };
}

/** Sparse update payload. QBO rejects an update without a current SyncToken. */
export function sparseUpdate(
  entityId: string,
  syncToken: string,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { Id: entityId, SyncToken: syncToken, sparse: true, ...fields };
}
