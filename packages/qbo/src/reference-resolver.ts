/**
 * Resolving names to QBO entity IDs.
 *
 * QBO rejects `"VendorRef": "Acme Ltd"`; it wants `{"value": "42"}`. Looking that
 * up costs an API call, and at 2M invoices/day with 2-4 refs each, naive lookup
 * would need ~6M extra QBO calls per day — far past the per-realm rate limit.
 *
 * So: a Postgres-backed cache keyed on a normalised name, populated on miss,
 * with a trigram fallback for near-matches. Steady-state hit rate for a typical
 * tenant is well above 99% because vendor sets are small and stable.
 */

import type pg from 'pg';
import { NotFoundError, type RealmId, type TenantId } from '@onelineflow/core';
import type { QboConnectionWithTokens } from '@onelineflow/db';
import { escapeQboLiteral, type QboClient, type QboRequestContext } from './client.js';

export type QboEntityType =
  'Vendor' | 'Customer' | 'Account' | 'Item' | 'TaxCode' | 'Term' | 'Class';

/** Same normalisation as the dedup key: casing and punctuation are noise. */
export function normaliseLookupKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface ResolvedReference {
  readonly qboId: string;
  readonly displayName: string;
  /** How we found it — surfaced to reviewers so a fuzzy match can be checked. */
  readonly matchType: 'cache' | 'exact' | 'fuzzy';
}

/** The field QBO matches on, per entity type. */
const NAME_FIELD: Readonly<Record<QboEntityType, string>> = {
  Vendor: 'DisplayName',
  Customer: 'DisplayName',
  Account: 'Name',
  Item: 'Name',
  TaxCode: 'Name',
  Term: 'Name',
  Class: 'Name',
};

export class ReferenceResolver {
  constructor(
    private readonly qbo: QboClient,
    /** Rows older than this are refreshed on next use. */
    private readonly staleAfterMs = 24 * 60 * 60 * 1000,
  ) {}

  async resolve(
    client: pg.PoolClient,
    ctx: QboRequestContext,
    connection: QboConnectionWithTokens,
    entityType: QboEntityType,
    name: string,
    opts: { allowFuzzy?: boolean; signal?: AbortSignal } = {},
  ): Promise<ResolvedReference> {
    const key = normaliseLookupKey(name);
    if (!key) {
      throw new NotFoundError(`Cannot resolve an empty ${entityType} name`, {
        context: { entityType, name },
      });
    }

    const cached = await this.readCache(client, ctx.tenantId, ctx.realmId, entityType, key);
    if (cached && Date.now() - cached.refreshedAt.getTime() < this.staleAfterMs) {
      return { qboId: cached.qboId, displayName: cached.displayName, matchType: 'cache' };
    }

    // Cache miss or stale: ask QBO.
    const field = NAME_FIELD[entityType];
    const rows = await this.qbo.query<{ Id: string; [k: string]: unknown }>(
      client,
      ctx,
      connection,
      `select * from ${entityType} where ${field} = '${escapeQboLiteral(name)}' maxresults 2`,
      opts.signal,
    );

    if (rows.length === 1) {
      const row = rows[0];
      /* istanbul ignore next -- length check guarantees presence */
      if (!row) throw new NotFoundError(`${entityType} lookup returned an empty row`);
      const rawName = row[field];
      const displayName = typeof rawName === 'string' ? rawName : name;
      await this.writeCache(
        client,
        ctx.tenantId,
        ctx.realmId,
        entityType,
        key,
        row.Id,
        displayName,
        row,
      );
      return { qboId: row.Id, displayName, matchType: 'exact' };
    }

    if (rows.length > 1) {
      // Ambiguous. Guessing here would post to the wrong ledger account, so we
      // refuse and let a human disambiguate once — the cache makes it once.
      throw new NotFoundError(
        `${entityType} "${name}" is ambiguous in QuickBooks (${rows.length} matches)`,
        {
          publicMessage: `Multiple ${entityType} records match "${name}". Pick one to continue.`,
          context: { entityType, name },
        },
      );
    }

    if (opts.allowFuzzy) {
      const near = await this.fuzzyFromCache(client, ctx.tenantId, ctx.realmId, entityType, name);
      if (near) return { ...near, matchType: 'fuzzy' };
    }

    // Deliberately NOT auto-creating the vendor. Auto-creation on a typo'd name
    // pollutes the tenant's chart of accounts permanently and is very hard to
    // undo. Creation is an explicit, reviewed action.
    throw new NotFoundError(`${entityType} "${name}" does not exist in QuickBooks`, {
      publicMessage: `"${name}" is not set up in QuickBooks yet.`,
      context: { entityType, name },
    });
  }

  private async readCache(
    client: pg.PoolClient,
    tenantId: TenantId,
    realmId: RealmId,
    entityType: QboEntityType,
    key: string,
  ): Promise<{ qboId: string; displayName: string; refreshedAt: Date } | null> {
    const { rows } = await client.query<{
      qbo_id: string;
      display_name: string;
      refreshed_at: Date;
    }>(
      `SELECT qbo_id, display_name, refreshed_at FROM qbo_reference_cache
        WHERE tenant_id = $1 AND realm_id = $2 AND entity_type = $3 AND lookup_key = $4`,
      [tenantId, realmId, entityType, key],
    );
    const r = rows[0];
    return r ? { qboId: r.qbo_id, displayName: r.display_name, refreshedAt: r.refreshed_at } : null;
  }

  private async writeCache(
    client: pg.PoolClient,
    tenantId: TenantId,
    realmId: RealmId,
    entityType: QboEntityType,
    key: string,
    qboId: string,
    displayName: string,
    payload: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO qbo_reference_cache
         (tenant_id, realm_id, entity_type, lookup_key, qbo_id, display_name, payload, refreshed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, now())
       ON CONFLICT (tenant_id, realm_id, entity_type, lookup_key) DO UPDATE SET
         qbo_id = EXCLUDED.qbo_id,
         display_name = EXCLUDED.display_name,
         payload = EXCLUDED.payload,
         refreshed_at = now()`,
      [tenantId, realmId, entityType, key, qboId, displayName, JSON.stringify(payload)],
    );
  }

  /**
   * Trigram similarity against names we have already seen. Threshold 0.55 is
   * deliberately conservative — a wrong vendor match is a misposted bill, so we
   * would rather return nothing and ask.
   */
  private async fuzzyFromCache(
    client: pg.PoolClient,
    tenantId: TenantId,
    realmId: RealmId,
    entityType: QboEntityType,
    name: string,
  ): Promise<{ qboId: string; displayName: string } | null> {
    const { rows } = await client.query<{ qbo_id: string; display_name: string; sim: number }>(
      `SELECT qbo_id, display_name, similarity(display_name, $4) AS sim
         FROM qbo_reference_cache
        WHERE tenant_id = $1 AND realm_id = $2 AND entity_type = $3
          AND similarity(display_name, $4) > 0.55
        ORDER BY sim DESC
        LIMIT 2`,
      [tenantId, realmId, entityType, name],
    );

    // Two close candidates is not a match, it is a coin flip. Refuse.
    if (rows.length !== 1) return null;
    const r = rows[0];
    /* istanbul ignore next -- length check guarantees presence */
    if (!r) return null;
    return { qboId: r.qbo_id, displayName: r.display_name };
  }

  /** Invalidate on a QBO webhook telling us the entity changed. */
  async invalidate(
    client: pg.PoolClient,
    tenantId: TenantId,
    realmId: RealmId,
    entityType: QboEntityType,
    qboId: string,
  ): Promise<void> {
    await client.query(
      `DELETE FROM qbo_reference_cache
        WHERE tenant_id = $1 AND realm_id = $2 AND entity_type = $3 AND qbo_id = $4`,
      [tenantId, realmId, entityType, qboId],
    );
  }
}
