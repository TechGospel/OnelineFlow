/**
 * JWT verification.
 *
 * This plugin is the thing that makes every authorisation rule in auth.ts and
 * every RLS policy in the database actually mean something. Until it is
 * installed, `req.auth` is undefined and `requireTenant` rejects everything —
 * which is the correct failure direction, but it is not a working API.
 *
 * Non-negotiables:
 *
 *   - **Algorithm allow-list.** Never trust the token's own `alg` header. The
 *     classic attack is swapping RS256 for HS256 so the *public* key gets used
 *     as an HMAC secret, letting anyone mint valid tokens. `jose` requires an
 *     explicit algorithm list and we pass an asymmetric-only one.
 *   - **`none` is impossible** as a consequence of the above.
 *   - **Issuer and audience are checked.** A valid token from a different system
 *     signed by the same IdP must not authenticate here.
 *   - **The tenant comes from the token.** Never from a header, query parameter,
 *     or body field. This is the single assumption the whole isolation model
 *     rests on.
 *   - **Membership is re-checked against the database** for state-changing
 *     requests. A token is a bearer credential valid until it expires; a user
 *     removed from a tenant five minutes ago still holds a good one.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  createLocalJWKSet,
  importSPKI,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { AuthError, ConfigError, type TenantId } from '@onelineflow/core';
import type { ApiDeps } from '../main.js';
import { contextFromClaims, type AuthContext, type Role } from '../auth.js';

/** Asymmetric only. Excluding HMAC is what defeats the alg-confusion attack. */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'];

/** Endpoints reachable without a token. Everything else requires one. */
const PUBLIC_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/v1/qbo/callback', // Intuit redirects a browser here; state is the credential.
  '/v1/webhooks/intuit', // Authenticated by HMAC signature instead.
]);

export interface JwtAuthOptions {
  readonly publicKeyPem?: string | undefined;
  readonly jwksJson?: string | undefined;
  readonly issuer: string;
  readonly audience: string;
  /** Tolerance for clock skew between us and the IdP. */
  readonly clockToleranceSec: number;
}

/**
 * Membership cache.
 *
 * Re-reading tenant_members on every request would add a query to the hot path.
 * A short TTL bounds how long a revoked membership stays usable — 30 seconds is
 * short enough to be defensible and long enough to absorb a burst.
 */
interface CachedMembership {
  readonly role: Role;
  readonly approvalLimitMinor: bigint | null;
  readonly expiresAt: number;
}

const MEMBERSHIP_TTL_MS = 30_000;

export const jwtAuthPlugin = fp<{ deps: ApiDeps; options: JwtAuthOptions }>(
  async (app, { deps, options }) => {
    const verifyKey = await buildKeyResolver(options);
    const membershipCache = new Map<string, CachedMembership>();

    app.decorateRequest('auth', undefined);

    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const path = req.routeOptions.url ?? req.url.split('?')[0] ?? '';
      if (PUBLIC_PATHS.has(path)) return;

      const token = bearerToken(req);
      if (!token) {
        throw new AuthError('Missing bearer token', {
          publicMessage: 'Sign in to continue.',
        });
      }

      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, verifyKey, {
          algorithms: ALLOWED_ALGORITHMS,
          issuer: options.issuer,
          audience: options.audience,
          clockTolerance: options.clockToleranceSec,
        });
        payload = result.payload;
      } catch (err) {
        // Deliberately uniform: never tell a caller whether the signature, the
        // expiry, the issuer or the audience was the problem.
        req.log.debug({ err }, 'token verification failed');
        throw new AuthError('Token verification failed', {
          publicMessage: 'Your session is invalid or has expired. Sign in again.',
          cause: err,
        });
      }

      const claimed = contextFromClaims(payload);

      // Re-check membership against the database. The token asserts a role; the
      // database is the authority on whether that role still holds.
      const live = await resolveMembership(deps, membershipCache, claimed);
      req.auth = live;

      // Bind the identity into the log context for the rest of the request.
      req.log = req.log.child({ tenantId: live.tenantId, userId: live.userId });

      void reply; // no early response; verification either throws or passes
    });
  },
  { name: 'jwt-auth' },
);

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  // Case-insensitive scheme, exactly one space, non-empty credential.
  const match = /^Bearer[ ]+(?<token>[A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  return match?.groups?.['token'] ?? null;
}

/**
 * Build the key resolver once at boot.
 *
 * A JWKS is preferred in production because it supports key rotation without a
 * redeploy. A single PEM is supported for simpler deployments and for tests.
 */
async function buildKeyResolver(options: JwtAuthOptions): Promise<JWTVerifyGetKey> {
  // Both branches are normalised to a resolver FUNCTION rather than one being a
  // bare key. jose overloads jwtVerify on this parameter, and a union of
  // "key or resolver" does not resolve cleanly against the overloads — wrapping
  // the static key keeps one code path and one type.
  if (options.jwksJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.jwksJson);
    } catch (err) {
      throw new ConfigError('JWT_JWKS is not valid JSON', { cause: err });
    }
    return createLocalJWKSet(parsed as Parameters<typeof createLocalJWKSet>[0]);
  }

  if (options.publicKeyPem) {
    // The key material itself determines the real algorithm; the allow-list
    // above independently constrains what the token is permitted to claim, so a
    // token asserting HS256 is rejected before the key is ever consulted.
    let key: Awaited<ReturnType<typeof importSPKI>>;
    try {
      key = await importSPKI(options.publicKeyPem, 'RS256');
    } catch (err) {
      throw new ConfigError('JWT_PUBLIC_KEY is not a valid SPKI PEM public key', {
        cause: err,
      });
    }
    return () => Promise.resolve(key);
  }

  throw new ConfigError('Either JWT_PUBLIC_KEY or JWT_JWKS must be configured');
}

/**
 * Confirm the user is still a member of the tenant, and take the role and
 * approval limit from the database rather than the token.
 *
 * The token's role claim is a hint. If an admin demotes someone, the change must
 * take effect within the cache TTL, not whenever their token happens to expire.
 */
async function resolveMembership(
  deps: ApiDeps,
  cache: Map<string, CachedMembership>,
  claimed: AuthContext,
): Promise<AuthContext> {
  const cacheKey = `${claimed.tenantId}:${claimed.userId}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return { ...claimed, role: hit.role, approvalLimitMinor: hit.approvalLimitMinor };
  }

  const row = await deps.db.withTenant(claimed.tenantId, async (client) => {
    const { rows } = await client.query<{
      role: Role;
      approval_limit_minor: bigint | null;
      tenant_status: string;
    }>(
      `SELECT m.role, m.approval_limit_minor, t.status AS tenant_status
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.user_id = $2`,
      [claimed.tenantId, claimed.userId],
    );
    return rows[0] ?? null;
  });

  if (!row) {
    // Cache the negative too, briefly, so a revoked user cannot turn every
    // request into a database round trip.
    cache.set(cacheKey, {
      role: 'viewer',
      approvalLimitMinor: 0n,
      expiresAt: Date.now() + 5_000,
    });
    throw new AuthError('User is not a member of this tenant', {
      publicMessage: 'You no longer have access to this workspace.',
      context: { tenantId: claimed.tenantId },
    });
  }

  if (row.tenant_status !== 'active') {
    throw new AuthError(`Tenant is ${row.tenant_status}`, {
      publicMessage: 'This workspace is suspended. Contact support.',
    });
  }

  const resolved: CachedMembership = {
    role: row.role,
    approvalLimitMinor: row.approval_limit_minor,
    expiresAt: Date.now() + MEMBERSHIP_TTL_MS,
  };
  cache.set(cacheKey, resolved);

  return {
    ...claimed,
    role: resolved.role,
    approvalLimitMinor: resolved.approvalLimitMinor,
  };
}

/** Test helper: build an AuthContext directly, bypassing token verification. */
export function testAuthContext(
  tenantId: TenantId,
  userId: string,
  role: Role,
  approvalLimitMinor: bigint | null = null,
): AuthContext {
  return {
    tenantId,
    userId: userId as AuthContext['userId'],
    role,
    approvalLimitMinor,
  };
}

export { bearerToken as parseBearerToken, ALLOWED_ALGORITHMS, PUBLIC_PATHS };
