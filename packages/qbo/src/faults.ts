/**
 * QuickBooks Online error classification.
 *
 * Two things make this necessary:
 *
 *   1. QBO frequently returns HTTP 200 with a `Fault` object in the body. Code
 *      that only checks `res.ok` treats a validation failure as a success and
 *      stores a nonexistent entity id.
 *   2. The retry decision is not derivable from the HTTP status. 6240 (duplicate)
 *      arrives as 400 but means "already done, stop"; 3200 arrives as 401 but
 *      sometimes means "token expired, refresh and retry once".
 *
 * Getting this table wrong is how integrations either double-post or wedge.
 *
 * Codes are drawn from Intuit's published error list; the default branch is
 * conservative because an unrecognised code is one we have not reasoned about.
 */

import {
  AuthError,
  ConflictError,
  RateLimitError,
  UpstreamError,
  ValidationError,
  type AppError,
} from '@onelineflow/core';

export interface QboFaultDetail {
  readonly code: string;
  readonly message: string;
  readonly detail: string;
  readonly element?: string;
}

export interface QboFault {
  readonly type: string;
  readonly errors: readonly QboFaultDetail[];
  readonly intuitTid?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- parsing an untyped upstream body */
export function parseFault(body: any, intuitTid?: string): QboFault | null {
  const fault = body?.Fault ?? body?.fault;
  if (!fault) return null;

  const rawErrors = Array.isArray(fault.Error) ? fault.Error : [fault.Error ?? {}];
  return {
    type: String(fault.type ?? 'Unknown'),
    ...(intuitTid !== undefined ? { intuitTid } : {}),
    errors: rawErrors.map((e: any) => ({
      code: String(e?.code ?? 'unknown'),
      message: String(e?.Message ?? e?.message ?? ''),
      detail: String(e?.Detail ?? e?.detail ?? ''),
      ...(e?.element ? { element: String(e.element) } : {}),
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A duplicate DocNumber. The bill already exists — never retry, reconcile. */
export const DUPLICATE_DOC_NUMBER = '6240';
/** Stale SyncToken. Re-read the entity and re-apply. */
export const STALE_OBJECT = '5010';
/** Object not found. */
export const OBJECT_NOT_FOUND = '610';

const AUTH_CODES = new Set(['3200', '3100', '100']);
const THROTTLE_CODES = new Set(['3001']);
/** Intuit's own transient/internal failures. */
const TRANSIENT_CODES = new Set(['500', '10000', '6000']);

export interface ClassifiedFault {
  readonly error: AppError;
  /** Duplicate detected: the caller should reconcile, not re-post. */
  readonly isDuplicate: boolean;
  /** SyncToken was stale: re-read then retry the update. */
  readonly isStaleObject: boolean;
  readonly primaryCode: string;
}

export function classifyFault(
  fault: QboFault,
  httpStatus: number,
  retryAfterMs?: number,
): ClassifiedFault {
  const primary = fault.errors[0];
  const code = primary?.code ?? 'unknown';
  const message = [primary?.message, primary?.detail].filter(Boolean).join(' :: ');
  const context = {
    qboCode: code,
    qboType: fault.type,
    intuitTid: fault.intuitTid,
    httpStatus,
    element: primary?.element,
  };

  if (code === DUPLICATE_DOC_NUMBER) {
    return {
      isDuplicate: true,
      isStaleObject: false,
      primaryCode: code,
      error: new ConflictError(`QBO duplicate document number: ${message}`, {
        publicMessage:
          'A bill with this document number already exists in QuickBooks. ' +
          'It was linked instead of being created again.',
        context,
      }),
    };
  }

  if (code === STALE_OBJECT) {
    return {
      isDuplicate: false,
      isStaleObject: true,
      primaryCode: code,
      error: new ConflictError(`QBO stale object: ${message}`, {
        publicMessage: 'This record changed in QuickBooks. Refreshing and retrying.',
        context,
      }),
    };
  }

  if (AUTH_CODES.has(code) || httpStatus === 401) {
    return {
      isDuplicate: false,
      isStaleObject: false,
      primaryCode: code,
      error: new AuthError(`QBO authentication failed: ${message}`, {
        publicMessage: 'QuickBooks authorisation has expired. Reconnect from Settings.',
        context,
      }),
    };
  }

  if (THROTTLE_CODES.has(code) || httpStatus === 429) {
    return {
      isDuplicate: false,
      isStaleObject: false,
      primaryCode: code,
      error: new RateLimitError(`QBO throttled: ${message}`, {
        publicMessage: 'QuickBooks is rate limiting us. Retrying shortly.',
        context,
        // Intuit's guidance when no Retry-After header is present.
        retryAfterMs: retryAfterMs ?? 60_000,
      }),
    };
  }

  if (TRANSIENT_CODES.has(code) || httpStatus >= 500) {
    return {
      isDuplicate: false,
      isStaleObject: false,
      primaryCode: code,
      error: new UpstreamError(`QBO upstream failure: ${message}`, {
        publicMessage: 'QuickBooks is temporarily unavailable. Retrying.',
        context,
      }),
    };
  }

  // Everything else is a validation problem with what WE sent: a bad account
  // ref, a closed period, a currency mismatch. Retrying sends the identical
  // payload and fails identically, so park it for a human.
  return {
    isDuplicate: false,
    isStaleObject: false,
    primaryCode: code,
    error: new ValidationError(`QBO rejected the request (${code}): ${message}`, {
      publicMessage: primary?.message ?? 'QuickBooks rejected this invoice.',
      context,
    }),
  };
}

/** Parse a Retry-After header, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}
