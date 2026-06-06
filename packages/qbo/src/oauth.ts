/**
 * Intuit OAuth 2.0.
 *
 * The important detail: Intuit rotates the refresh token on every refresh and
 * invalidates the old one. Losing the new value — by crashing after the HTTP
 * call but before the database commit — permanently breaks the connection. So
 * `refreshTokens` is pure: it performs the exchange and returns the tokens. The
 * caller persists them inside the same advisory lock that serialised the
 * refresh. See ConnectionRepository.withRefreshLock.
 */

import {
  AuthError,
  QBO_AUTHORIZE_URL,
  QBO_REVOKE_URL,
  QBO_TOKEN_URL,
  UpstreamError,
  withTimeout,
} from '@onelineflow/core';
import type { QboTokens } from '@onelineflow/db';

export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly timeoutMs: number;
}

/**
 * Intuit's access tokens last ~1 hour and refresh tokens ~100 days. We treat an
 * access token as expired 5 minutes early so a long request cannot start on a
 * token that dies mid-flight.
 */
const ACCESS_TOKEN_SKEW_MS = 5 * 60_000;

export function isAccessTokenExpired(expiresAt: Date, now = Date.now()): boolean {
  return expiresAt.getTime() - ACCESS_TOKEN_SKEW_MS <= now;
}

export function buildAuthorizeUrl(cfg: OAuthConfig, state: string): string {
  const url = new URL(QBO_AUTHORIZE_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  // Opaque, single-use, bound to the user's session. CSRF protection on the
  // callback — without it an attacker can graft their realm onto a victim's tenant.
  url.searchParams.set('state', state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

async function tokenRequest(
  cfg: OAuthConfig,
  body: URLSearchParams,
  operation: string,
): Promise<QboTokens> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const res = await withTimeout(
    (signal) =>
      fetch(QBO_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal,
      }),
    cfg.timeoutMs,
    `qbo.oauth.${operation}`,
  );

  const text = await res.text();

  if (!res.ok) {
    // invalid_grant is terminal: the refresh token is dead and no amount of
    // retrying revives it. Anything else may be transient.
    const terminal = text.includes('invalid_grant') || res.status === 400;
    const detail = `${res.status} ${text.slice(0, 500)}`;
    throw terminal
      ? new AuthError(`Intuit ${operation} rejected: ${detail}`, {
          publicMessage: 'QuickBooks authorisation has expired. Please reconnect.',
          context: { operation, status: res.status },
        })
      : new UpstreamError(`Intuit ${operation} failed: ${detail}`, {
          context: { operation, status: res.status },
        });
  }

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch (err) {
    throw new UpstreamError('Intuit returned a non-JSON token response', { cause: err });
  }

  if (!parsed.access_token || !parsed.refresh_token) {
    throw new UpstreamError('Intuit token response is missing required fields');
  }

  const now = Date.now();
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessTokenExpiresAt: new Date(now + parsed.expires_in * 1000),
    refreshTokenExpiresAt: new Date(now + parsed.x_refresh_token_expires_in * 1000),
  };
}

export async function exchangeAuthorizationCode(
  cfg: OAuthConfig,
  code: string,
): Promise<QboTokens> {
  return tokenRequest(
    cfg,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
    }),
    'authorization_code',
  );
}

export async function refreshTokens(cfg: OAuthConfig, refreshToken: string): Promise<QboTokens> {
  return tokenRequest(
    cfg,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    'refresh_token',
  );
}

/** Best-effort revoke on disconnect. Failure here must not block the disconnect. */
export async function revokeToken(cfg: OAuthConfig, token: string): Promise<void> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  await withTimeout(
    (signal) =>
      fetch(QBO_REVOKE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ token }),
        signal,
      }),
    cfg.timeoutMs,
    'qbo.oauth.revoke',
  );
}
