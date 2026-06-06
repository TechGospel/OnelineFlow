/**
 * The QuickBooks Online HTTP client.
 *
 * Every outbound QBO call in the platform goes through `request()`. That is
 * deliberate — it is the only way to guarantee that rate limiting, token
 * refresh, fault classification, audit logging and timeouts are applied
 * uniformly. There is no "just fetch it directly" path.
 *
 * Order of operations per call:
 *   1. acquire rate-limit token + concurrency slot for the realm
 *   2. ensure a live access token (refresh under a cluster-wide lock if needed)
 *   3. issue the request with a hard timeout
 *   4. parse the body BEFORE trusting the status code
 *   5. classify any fault into a typed, retry-aware error
 *   6. log a redacted record of the exchange
 *   7. release the slot
 */

import {
  qboBaseUrl,
  TimeoutError,
  UpstreamError,
  withTimeout,
  type RealmId,
  type TenantId,
} from '@onelineflow/core';
import type { ConnectionRepository, QboConnectionWithTokens } from '@onelineflow/db';
import type pg from 'pg';
import { classifyFault, parseFault, parseRetryAfter } from './faults.js';
import { isAccessTokenExpired, refreshTokens, type OAuthConfig } from './oauth.js';
import type { QboRateLimiter } from './rate-limiter.js';
import { redact } from './redact.js';

export interface QboClientOptions {
  readonly environment: 'sandbox' | 'production';
  readonly minorVersion: string;
  readonly timeoutMs: number;
  readonly oauth: OAuthConfig;
}

export interface QboRequestContext {
  readonly tenantId: TenantId;
  readonly realmId: RealmId;
  /** For the audit trail; nullable for reference lookups. */
  readonly invoiceId?: string;
  readonly attempt?: number;
}

export interface QboRequestInit {
  readonly method: 'GET' | 'POST';
  /** Path after /v3/company/{realmId}, e.g. "/bill". */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Intuit's server-side idempotency key. */
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface AuditSink {
  record(entry: {
    tenantId: TenantId;
    realmId: RealmId;
    invoiceId?: string;
    method: string;
    path: string;
    requestId?: string;
    httpStatus: number | null;
    intuitTid: string | null;
    faultCode: string | null;
    durationMs: number;
    attempt: number;
    requestBody: unknown;
    responseBody: unknown;
  }): Promise<void>;
}

export class QboClient {
  constructor(
    private readonly opts: QboClientOptions,
    private readonly limiter: QboRateLimiter,
    private readonly connections: ConnectionRepository,
    private readonly audit: AuditSink,
  ) {}

  /**
   * Return a usable access token, refreshing under a cluster-wide advisory lock
   * if it is expired or about to be.
   *
   * The double-check inside the lock is what prevents the thundering-herd
   * refresh: by the time a loser acquires the lock, the winner has already
   * stored a fresh token, so `reload()` returns it and no second exchange runs.
   */
  private async ensureToken(
    client: pg.PoolClient,
    connection: QboConnectionWithTokens,
  ): Promise<QboConnectionWithTokens> {
    if (!isAccessTokenExpired(connection.tokens.accessTokenExpiresAt)) {
      return connection;
    }

    return this.connections.withRefreshLock(client, connection.id, async (reload) => {
      const current = await reload();
      if (!isAccessTokenExpired(current.tokens.accessTokenExpiresAt)) {
        return current; // Another worker already refreshed. Nothing to do.
      }

      const fresh = await refreshTokens(this.opts.oauth, current.tokens.refreshToken);
      await this.connections.upsert(client, {
        tenantId: current.tenantId,
        realmId: current.realmId,
        environment: current.environment,
        tokens: fresh,
      });
      return { ...current, tokens: fresh, accessTokenExpiresAt: fresh.accessTokenExpiresAt };
    });
  }

  async request<T = unknown>(
    client: pg.PoolClient,
    ctx: QboRequestContext,
    connection: QboConnectionWithTokens,
    init: QboRequestInit,
  ): Promise<T> {
    const lease = await this.limiter.acquire(ctx.realmId, this.opts.timeoutMs, init.signal);
    const started = Date.now();

    let httpStatus: number | null = null;
    let intuitTid: string | null = null;
    let faultCode: string | null = null;
    let responseBody: unknown = null;

    try {
      const live = await this.ensureToken(client, connection);

      const url = new URL(
        `${qboBaseUrl(this.opts.environment)}/v3/company/${ctx.realmId}${init.path}`,
      );
      url.searchParams.set('minorversion', this.opts.minorVersion);
      if (init.requestId) url.searchParams.set('requestid', init.requestId);
      for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

      const res = await withTimeout(
        (signal) =>
          fetch(url, {
            method: init.method,
            headers: {
              Authorization: `Bearer ${live.tokens.accessToken}`,
              Accept: 'application/json',
              ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
            signal,
          }),
        this.opts.timeoutMs,
        `qbo.${init.method}.${init.path}`,
        init.signal,
      );

      httpStatus = res.status;
      intuitTid = res.headers.get('intuit_tid');

      const text = await res.text();
      // Parse before checking res.ok: QBO returns faults with HTTP 200.
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new UpstreamError(`QBO returned non-JSON (${res.status}): ${text.slice(0, 300)}`, {
            context: { status: res.status, intuitTid },
          });
        }
      }
      responseBody = parsed;

      const fault = parseFault(parsed, intuitTid ?? undefined);
      if (fault) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const classified = classifyFault(fault, res.status, retryAfter);
        faultCode = classified.primaryCode;

        // A 429 should slow the whole fleet, not just this worker.
        if (classified.error.category === 'rate_limit') {
          await this.limiter.penalise(ctx.realmId, classified.error.retryAfterMs ?? 60_000);
        }
        throw classified.error;
      }

      if (!res.ok) {
        // Non-2xx with no parseable Fault. Classify on status alone.
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const classified = classifyFault(
          {
            type: 'HttpError',
            errors: [{ code: String(res.status), message: text.slice(0, 300), detail: '' }],
          },
          res.status,
          retryAfter,
        );
        faultCode = classified.primaryCode;
        throw classified.error;
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof TimeoutError) {
        // A timed-out write is the dangerous case: QBO may have committed it.
        // The caller must reconcile by requestid rather than blindly retrying.
        faultCode = 'timeout';
      }
      throw err;
    } finally {
      await lease.release();
      // Audit is best-effort: never let a logging failure fail a posted invoice.
      void this.audit
        .record({
          tenantId: ctx.tenantId,
          realmId: ctx.realmId,
          ...(ctx.invoiceId !== undefined ? { invoiceId: ctx.invoiceId } : {}),
          method: init.method,
          path: init.path,
          ...(init.requestId !== undefined ? { requestId: init.requestId } : {}),
          httpStatus,
          intuitTid,
          faultCode,
          durationMs: Date.now() - started,
          attempt: ctx.attempt ?? 1,
          requestBody: redact(init.body),
          responseBody: redact(responseBody),
        })
        .catch(() => {});
    }
  }

  /**
   * Run a QBO SQL-ish query.
   *
   * `value` is escaped for the single-quoted string context QBO uses. There is
   * no parameterised form in their API, so escaping is the only defence and it
   * lives here rather than at each call site.
   */
  async query<T = unknown>(
    client: pg.PoolClient,
    ctx: QboRequestContext,
    connection: QboConnectionWithTokens,
    statement: string,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const res = await this.request<{ QueryResponse?: Record<string, T[]> }>(
      client,
      ctx,
      connection,
      {
        method: 'GET',
        path: '/query',
        query: { query: statement },
        ...(signal !== undefined ? { signal } : {}),
      },
    );

    const qr = res.QueryResponse ?? {};
    // QueryResponse is keyed by entity name; take the first array present.
    for (const value of Object.values(qr)) {
      if (Array.isArray(value)) return value;
    }
    return [];
  }
}

/**
 * Escape a value for interpolation into a QBO query string literal.
 *
 * QBO's query language has no bind parameters. A vendor legitimately named
 * "O'Brien & Sons" breaks an unescaped query; a vendor name crafted to contain
 * a quote could alter it. Backslash-escape both the escape character and the
 * quote, and reject control characters outright.
 */
export function escapeQboLiteral(value: string): string {
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new UpstreamError('Refusing to build a QBO query containing control characters');
  }
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
