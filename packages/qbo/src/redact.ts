/**
 * Redaction for anything that reaches logs or the qbo_api_calls audit table.
 *
 * Bearer tokens in a log line are a credential leak with a long tail: logs are
 * replicated to a SIEM, retained for a year, and readable by more people than
 * the database is. Redaction happens at the boundary, once, so no call site has
 * to remember.
 */

const SENSITIVE_KEYS = new Set([
  'authorization',
  'access_token',
  'refresh_token',
  'client_secret',
  'id_token',
  'password',
  'x-api-key',
  'apikey',
  'cookie',
  'set-cookie',
]);

/** Fields that identify a person or a bank account rather than a transaction. */
const PII_KEYS = new Set([
  'ssn',
  'taxidentifier',
  'accountnumber',
  'routingnumber',
  'bankaccountnumber',
  'primaryemailaddr',
  'primaryphone',
  'mobile',
]);

const MAX_DEPTH = 12;
const MAX_STRING = 4000;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    // Cap array length so one 500-line invoice does not produce a 2MB log line.
    const capped = value.slice(0, 100).map((v) => redact(v, depth + 1));
    if (value.length > 100) capped.push(`[+${value.length - 100} more]`);
    return capped;
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) {
      out[key] = '[redacted]';
    } else if (PII_KEYS.has(lower)) {
      out[key] = maskTail(v);
    } else {
      out[key] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Keep the last four characters so support can still match a record. */
function maskTail(value: unknown): string {
  // Only primitives can be meaningfully masked; anything else is replaced
  // wholesale rather than stringified into "[object Object]".
  if (value === null || value === undefined) return '****';
  if (typeof value === 'object') return '[redacted-object]';
  // Narrowed to a primitive by the guards above.
  const s = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
}

export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}
