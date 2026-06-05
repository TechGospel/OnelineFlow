/**
 * Postgres access with mandatory tenant scoping.
 *
 * The only way to obtain a client is `withTenant()` or `withBypass()`. Both set
 * the RLS GUC and — critically — reset it in a `finally`. A pooled connection
 * returned to the pool still carrying `app.tenant_id` is a cross-tenant data
 * leak waiting for the next checkout, so the reset is not optional and is
 * covered by a test.
 */

import pg from 'pg';
import { ConfigError, InternalError, isUuid, type TenantId } from '@onelineflow/core';

const { Pool, types } = pg;

/**
 * node-postgres returns bigint (OID 20) as a string to avoid precision loss.
 * We want real bigints for money, and we want that conversion to be explicit
 * rather than something each call site remembers.
 */
types.setTypeParser(20, (value: string) => BigInt(value));
/** numeric (OID 1700): keep as string. Never silently become a float. */
types.setTypeParser(1700, (value: string) => value);

export interface PoolOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
  readonly ssl?: pg.PoolConfig['ssl'];
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

export class Database {
  private readonly pool: pg.Pool;
  private closing = false;

  constructor(opts: PoolOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max,
      application_name: opts.applicationName,
      // A checkout that waits longer than this means the pool is saturated;
      // failing fast sheds load instead of building an unbounded queue.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: opts.statementTimeoutMs,
      // Belt and braces: kill a transaction that holds locks while idle.
      idle_in_transaction_session_timeout: 30_000,
      ...(opts.ssl !== undefined ? { ssl: opts.ssl } : {}),
    });

    // An idle-client error (server restart, failover) must not take down the
    // process; the pool discards the client and the next checkout reconnects.
    this.pool.on('error', (err) => {
      if (this.closing) return;
      console.error('[db] idle client error', err);
    });
  }

  /**
   * Run `fn` with every statement scoped to one tenant.
   *
   * `SET LOCAL` would be cleaner but only works inside a transaction, and we do
   * not want to force a transaction on read paths. So we `set_config(..., false)`
   * (session scope) and unconditionally clear it in the finally block.
   */
  async withTenant<T>(tenantId: TenantId, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) {
      // Defence in depth: this value is interpolated into set_config. It is
      // already parameterised below, but a non-UUID here means a bug upstream.
      throw new InternalError(`Refusing to scope to a non-UUID tenant: ${tenantId}`);
    }

    const client = await this.pool.connect();
    let result: T;
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenantId]);
      result = await fn(client);
    } catch (err) {
      // The body failed, but the connection still carries this tenant's context
      // and must not go back into the pool holding it. Clean up, then rethrow
      // the ORIGINAL error — a cleanup problem must never mask the real cause.
      await this.releaseScoped(client, false);
      throw err;
    }

    // Body succeeded, so a cleanup failure is now the only thing that can go
    // wrong, and it is worth surfacing.
    await this.releaseScoped(client, true);
    return result;
  }

  /**
   * Clear the RLS session variables and return the client to the pool.
   *
   * A connection whose GUCs cannot be cleared is destroyed rather than reused:
   * handing a tenant-tainted client to the next checkout is a cross-tenant data
   * leak, and losing one pooled connection is trivially cheap by comparison.
   *
   * Note this is deliberately NOT done in a `finally` block at the call site.
   * A `return` or `throw` inside `finally` silently discards whatever exception
   * was already propagating, which is how the real error goes missing.
   */
  private async releaseScoped(client: pg.PoolClient, reportFailure: boolean): Promise<void> {
    try {
      await client.query('SELECT set_config($1, $2, false), set_config($3, $4, false)', [
        'app.tenant_id',
        '',
        'app.bypass_rls',
        'off',
      ]);
    } catch (err) {
      client.release(true); // destroy
      if (reportFailure) {
        throw new InternalError('Failed to clear tenant context; connection destroyed', {
          cause: err,
        });
      }
      return;
    }
    client.release();
  }

  /**
   * Cross-tenant access for the reconciler, partition maintenance, and the
   * outbox relay. Every call site must pass a `reason`, which is logged — this
   * is the one path that can see every tenant's data and it should be auditable
   * by grepping.
   */
  async withBypass<T>(reason: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!reason.trim()) {
      throw new ConfigError('withBypass requires a non-empty reason for the audit trail');
    }
    const client = await this.pool.connect();
    let result: T;
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.bypass_rls', 'on']);
      result = await fn(client);
    } catch (err) {
      // Same reasoning as withTenant: a client still holding bypass is the most
      // dangerous thing that can be returned to the pool.
      await this.releaseScoped(client, false);
      throw err;
    }
    await this.releaseScoped(client, true);
    return result;
  }

  /**
   * Transaction helper with SERIALIZABLE-conflict awareness left to the caller.
   * Rolls back on any throw, including a throw from the rollback path itself.
   */
  async transaction<T>(
    client: pg.PoolClient,
    fn: (tx: pg.PoolClient) => Promise<T>,
    isolation: 'read committed' | 'repeatable read' | 'serializable' = 'read committed',
  ): Promise<T> {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection is already broken; the pool will discard it.
      }
      throw err;
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT 1 AS ok');
      return res.rows[0]?.['ok'] === 1;
    } catch {
      return false;
    }
  }

  get stats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.pool.end();
  }
}
