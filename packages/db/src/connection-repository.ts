/**
 * QBO connection storage.
 *
 * The hard part is the refresh race. Intuit ROTATES the refresh token on every
 * refresh and invalidates the previous one. So if twenty workers notice an
 * expired access token at the same instant and all call refresh:
 *
 *   - one succeeds and stores refresh token R2,
 *   - nineteen present the now-dead R1 and get invalid_grant,
 *   - if any of those nineteen writes its failure state, the connection is
 *     marked dead while actually being healthy.
 *
 * The whole tenant's pipeline then stops until someone re-authorises by hand.
 *
 * The fix is a Postgres advisory lock keyed on the connection id: exactly one
 * refresh at a time per connection, cluster-wide, with the losers re-reading the
 * freshly stored token instead of refreshing again.
 */

import type pg from 'pg';
import { createHash } from 'node:crypto';
import {
  AuthError,
  NotFoundError,
  type ConnectionId,
  type RealmId,
  type TenantId,
} from '@onelineflow/core';
import { aad, generateDek, open, seal, type Keyring } from '@onelineflow/crypto';

export interface QboTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
}

export interface QboConnection {
  readonly id: ConnectionId;
  readonly tenantId: TenantId;
  readonly realmId: RealmId;
  readonly environment: 'sandbox' | 'production';
  readonly status: 'active' | 'reauth_required' | 'revoked';
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
  readonly consecutiveFailures: number;
}

export interface QboConnectionWithTokens extends QboConnection {
  readonly tokens: QboTokens;
}

/** 64-bit advisory-lock key derived from the connection UUID. */
function advisoryKey(connectionId: ConnectionId): bigint {
  const digest = createHash('sha256').update(`qbo-refresh:${connectionId}`).digest();
  // Read 8 bytes as signed — pg_advisory_lock(bigint) takes a signed value.
  return digest.readBigInt64BE(0);
}

export class ConnectionRepository {
  constructor(private readonly keyring: Keyring) {}

  async findActive(
    client: pg.PoolClient,
    tenantId: TenantId,
    realmId: RealmId,
  ): Promise<QboConnectionWithTokens> {
    const { rows } = await client.query(
      `SELECT id, tenant_id, realm_id, environment, status,
              access_token_ct, refresh_token_ct, wrapped_dek, key_version,
              access_token_expires_at, refresh_token_expires_at, consecutive_failures
         FROM qbo_connections
        WHERE tenant_id = $1 AND realm_id = $2 AND status = 'active'`,
      [tenantId, realmId],
    );

    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`No active QBO connection for realm ${realmId}`, {
        publicMessage: 'QuickBooks is not connected. Reconnect from Settings.',
        context: { tenantId, realmId },
      });
    }
    return this.hydrate(row);
  }

  async findById(client: pg.PoolClient, id: ConnectionId): Promise<QboConnectionWithTokens | null> {
    const { rows } = await client.query(
      `SELECT id, tenant_id, realm_id, environment, status,
              access_token_ct, refresh_token_ct, wrapped_dek, key_version,
              access_token_expires_at, refresh_token_expires_at, consecutive_failures
         FROM qbo_connections WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any -- row mapping boundary */
  private async hydrate(row: any): Promise<QboConnectionWithTokens> {
    const dek = await this.keyring.unwrapDek(row.wrapped_dek, row.key_version);
    const ad = aad(row.tenant_id, 'qbo-token');
    try {
      return {
        id: row.id,
        tenantId: row.tenant_id,
        realmId: row.realm_id,
        environment: row.environment,
        status: row.status,
        accessTokenExpiresAt: row.access_token_expires_at,
        refreshTokenExpiresAt: row.refresh_token_expires_at,
        consecutiveFailures: row.consecutive_failures,
        tokens: {
          accessToken: open(row.access_token_ct, dek, ad),
          refreshToken: open(row.refresh_token_ct, dek, ad),
          accessTokenExpiresAt: row.access_token_expires_at,
          refreshTokenExpiresAt: row.refresh_token_expires_at,
        },
      };
    } finally {
      // Zero the DEK rather than leaving it for the GC to hand to whoever reads
      // freed heap next. Cheap, and it shrinks the window for a memory dump.
      dek.fill(0);
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  async upsert(
    client: pg.PoolClient,
    params: {
      tenantId: TenantId;
      realmId: RealmId;
      environment: 'sandbox' | 'production';
      tokens: QboTokens;
    },
  ): Promise<ConnectionId> {
    const dek = generateDek();
    try {
      const { wrapped, keyVersion } = await this.keyring.wrapDek(dek);
      const ad = aad(params.tenantId, 'qbo-token');

      const { rows } = await client.query<{ id: ConnectionId }>(
        `INSERT INTO qbo_connections
           (tenant_id, realm_id, environment, access_token_ct, refresh_token_ct,
            wrapped_dek, key_version, access_token_expires_at,
            refresh_token_expires_at, status, last_refreshed_at, consecutive_failures)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',now(),0)
         ON CONFLICT (tenant_id, realm_id, environment) DO UPDATE SET
           access_token_ct = EXCLUDED.access_token_ct,
           refresh_token_ct = EXCLUDED.refresh_token_ct,
           wrapped_dek = EXCLUDED.wrapped_dek,
           key_version = EXCLUDED.key_version,
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
           status = 'active',
           last_refreshed_at = now(),
           consecutive_failures = 0,
           last_error = NULL
         RETURNING id`,
        [
          params.tenantId,
          params.realmId,
          params.environment,
          seal(params.tokens.accessToken, dek, ad),
          seal(params.tokens.refreshToken, dek, ad),
          wrapped,
          keyVersion,
          params.tokens.accessTokenExpiresAt,
          params.tokens.refreshTokenExpiresAt,
        ],
      );

      const id = rows[0]?.id;
      /* istanbul ignore next -- RETURNING always yields a row */
      if (!id) throw new NotFoundError('Upsert returned no connection id');
      return id;
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Serialise refresh across the whole cluster.
   *
   * `refresh` is only invoked by the winner. Everyone else blocks on the lock,
   * then `reload` returns the token the winner just stored. This is the single
   * most important function in the QBO integration.
   */
  async withRefreshLock<T>(
    client: pg.PoolClient,
    connectionId: ConnectionId,
    fn: (reload: () => Promise<QboConnectionWithTokens>) => Promise<T>,
  ): Promise<T> {
    const key = advisoryKey(connectionId);
    await client.query('SELECT pg_advisory_lock($1)', [key.toString()]);
    try {
      return await fn(async () => {
        const fresh = await this.findById(client, connectionId);
        if (!fresh) throw new NotFoundError(`Connection ${connectionId} disappeared`);
        if (fresh.status !== 'active') {
          throw new AuthError(`Connection ${connectionId} is ${fresh.status}`, {
            publicMessage: 'QuickBooks needs to be reconnected.',
          });
        }
        return fresh;
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key.toString()]).catch(() => {});
    }
  }

  /**
   * Record a failure. Only flips to `reauth_required` on a hard auth error —
   * transient upstream failures must never cost a tenant a manual reconnect.
   */
  async recordFailure(
    client: pg.PoolClient,
    id: ConnectionId,
    error: string,
    fatal: boolean,
  ): Promise<void> {
    await client.query(
      `UPDATE qbo_connections
          SET consecutive_failures = consecutive_failures + 1,
              last_error = $2,
              status = CASE WHEN $3 THEN 'reauth_required' ELSE status END
        WHERE id = $1`,
      [id, error.slice(0, 2000), fatal],
    );
  }

  /** Connections whose refresh token expires soon. Drives proactive alerting. */
  async findExpiringSoon(client: pg.PoolClient, withinDays: number): Promise<QboConnection[]> {
    const { rows } = await client.query(
      `SELECT id, tenant_id, realm_id, environment, status,
              access_token_expires_at, refresh_token_expires_at, consecutive_failures
         FROM qbo_connections
        WHERE status = 'active'
          AND refresh_token_expires_at < now() + make_interval(days => $1)
        ORDER BY refresh_token_expires_at`,
      [withinDays],
    );
    /* eslint-disable @typescript-eslint/no-explicit-any -- row mapping boundary */
    return rows.map((r: any) => ({
      id: r.id,
      tenantId: r.tenant_id,
      realmId: r.realm_id,
      environment: r.environment,
      status: r.status,
      accessTokenExpiresAt: r.access_token_expires_at,
      refreshTokenExpiresAt: r.refresh_token_expires_at,
      consecutiveFailures: r.consecutive_failures,
    }));
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
}
