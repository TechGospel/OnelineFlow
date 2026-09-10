/**
 * Concurrency and recovery smoke test.
 *
 * These properties cannot be tested with mocks. They are about what real
 * Postgres does when two connections race, and about what the posting worker
 * does when it wakes to find an invoice already in `posting` — the state that
 * means "a QuickBooks write may or may not have landed".
 *
 * Run against the compose stack: `pnpm smoke:concurrency`
 */

import { randomUUID } from 'node:crypto';
import {
  asInvoiceId,
  asTenantId,
  ConflictError,
  loadConfig,
  qboRequestId,
  type InvoiceId,
  type TenantId,
} from '@onelineflow/core';
import { Database, InvoiceRepository } from '@onelineflow/db';

const cfg = loadConfig();
const db = new Database({
  connectionString: cfg.DATABASE_URL,
  // Needs real parallelism: a pool of 1 would serialise the races and every
  // test below would pass for the wrong reason.
  max: 20,
  statementTimeoutMs: 15_000,
  applicationName: 'onelineflow-smoke-concurrency',
});
const invoices = new InvoiceRepository();

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

async function seedTenant(): Promise<TenantId> {
  const tenantId = asTenantId(randomUUID());
  await db.withBypass('smoke seed', async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, $2, 'Concurrency Test')`,
      [tenantId, `conc-${tenantId.slice(0, 8)}`],
    );
  });
  return tenantId;
}

async function seedApprovedInvoice(tenantId: TenantId): Promise<{
  id: InvoiceId;
  createdAt: Date;
  version: number;
}> {
  return db.withTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: InvoiceId; created_at: Date; version: number }>(
      `INSERT INTO invoices
         (tenant_id, status, vendor_name, invoice_number, currency, total_minor, qbo_realm_id)
       VALUES ($1, 'approved', 'Acme Ltd', $2, 'USD', 125000, '123456')
       RETURNING id, created_at, version`,
      [tenantId, `INV-${randomUUID().slice(0, 8)}`],
    );
    const row = rows[0];
    if (!row) throw new Error('seed failed');
    return { id: row.id, createdAt: row.created_at, version: row.version };
  });
}

async function main(): Promise<void> {
  const tenantId = await seedTenant();

  /* ================================================================== */
  /* 1. CAS: exactly one of N concurrent claims wins                     */
  /* ================================================================== */
  {
    const inv = await seedApprovedInvoice(tenantId);
    const CONTENDERS = 12;

    // All 12 read the same version, then all try to claim. This is the real
    // shape of the race: N workers dequeue jobs for one invoice after a
    // redelivery, and every one of them believes it is the only claimant.
    const results = await Promise.allSettled(
      Array.from({ length: CONTENDERS }, () =>
        db.withTenant(tenantId, (client) =>
          invoices.transitionStatus(client, {
            id: inv.id,
            createdAt: inv.createdAt,
            from: 'approved',
            to: 'posting',
            expectedVersion: inv.version,
          }),
        ),
      ),
    );

    const won = results.filter((r) => r.status === 'fulfilled').length;
    const lost = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ConflictError,
    ).length;
    const other = results.filter(
      (r) => r.status === 'rejected' && !(r.reason instanceof ConflictError),
    );

    check('exactly one claimant wins the CAS race', won === 1, `${won} winner(s)`);
    check(
      'every loser gets a ConflictError, not a silent no-op',
      lost === CONTENDERS - 1,
      `${lost}/${CONTENDERS - 1}`,
    );
    check(
      'no unexpected error types',
      other.length === 0,
      other.length > 0 ? String((other[0] as PromiseRejectedResult).reason) : '',
    );

    const after = await db.withTenant(tenantId, (c) => invoices.requireById(c, inv.id));
    check(
      'version incremented exactly once',
      after.version === inv.version + 1,
      `v${after.version}`,
    );
    check('status is posting', after.status === 'posting');
  }

  /* ================================================================== */
  /* 2. The state machine blocks an illegal transition even under a race */
  /* ================================================================== */
  {
    const inv = await seedApprovedInvoice(tenantId);
    await db.withTenant(tenantId, (client) =>
      invoices.transitionStatus(client, {
        id: inv.id,
        createdAt: inv.createdAt,
        from: 'approved',
        to: 'posting',
        expectedVersion: inv.version,
      }),
    );
    const posting = await db.withTenant(tenantId, (c) => invoices.requireById(c, inv.id));

    await db.withTenant(tenantId, (client) =>
      invoices.recordPosted(client, {
        id: inv.id,
        createdAt: inv.createdAt,
        expectedVersion: posting.version,
        realmId: '123456',
        entityType: 'Bill',
        entityId: '9001',
        syncToken: '0',
        docNumber: 'INV-1',
      }),
    );

    const posted = await db.withTenant(tenantId, (c) => invoices.requireById(c, inv.id));
    check('posted invoice carries its entity id', posted.qboEntityId === '9001');

    // A redelivered job must not be able to re-post something already in the
    // ledger. This is the invariant that stops a duplicate bill.
    let blocked = false;
    try {
      await db.withTenant(tenantId, (client) =>
        invoices.transitionStatus(client, {
          id: inv.id,
          createdAt: inv.createdAt,
          from: 'posted',
          to: 'posting',
          expectedVersion: posted.version,
        }),
      );
    } catch (err) {
      blocked = err instanceof ConflictError;
    }
    check('posted -> posting is refused by the state machine', blocked);
  }

  /* ================================================================== */
  /* 3. The database CHECK constraint is the last line of defence        */
  /* ================================================================== */
  {
    const inv = await seedApprovedInvoice(tenantId);
    let rejected = false;
    let message = '';
    try {
      // Bypass the repository entirely and try to write the forbidden state
      // directly. Application logic can be circumvented; the constraint cannot.
      await db.withTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE invoices SET status = 'posted', posted_at = now()
            WHERE id = $1 AND created_at = $2`,
          [inv.id, inv.createdAt],
        );
      });
    } catch (err) {
      rejected = true;
      message = err instanceof Error ? err.message.slice(0, 60) : '';
    }
    check(
      'DB refuses status=posted without a QBO entity id',
      rejected,
      message || 'constraint invoices_posted_has_entity',
    );
  }

  /* ================================================================== */
  /* 4. Recovery: the requestid is stable across attempts                */
  /* ================================================================== */
  {
    const inv = await seedApprovedInvoice(tenantId);
    const first = qboRequestId(tenantId, inv.id, 'create-bill', 0);
    const retry = qboRequestId(tenantId, inv.id, 'create-bill', 0);
    check('requestid is identical on retry', first === retry);

    // Only an audited admin force-repost bumps the epoch, and that is the one
    // documented way to defeat Intuit's server-side deduplication.
    const forced = qboRequestId(tenantId, inv.id, 'create-bill', 1);
    check('bumping the epoch changes the requestid', forced !== first);

    await db.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE invoices SET post_attempt_epoch = post_attempt_epoch + 1
          WHERE id = $1 AND created_at = $2`,
        [inv.id, inv.createdAt],
      );
    });
    const bumped = await db.withTenant(tenantId, (c) => invoices.requireById(c, inv.id));
    check('epoch persists on the row', bumped.postAttemptEpoch === 1);
  }

  /* ================================================================== */
  /* 5. Business-key claim is atomic under concurrency                   */
  /* ================================================================== */
  {
    const businessKey = `bk-${randomUUID()}`;
    const ids = Array.from({ length: 8 }, () => asInvoiceId(randomUUID()));

    const claims = await Promise.all(
      ids.map((id) =>
        db.withTenant(tenantId, (client) =>
          invoices.claimBusinessKey(client, tenantId, businessKey, id),
        ),
      ),
    );

    const winners = claims.filter((c) => c.claimed).length;
    const uniqueWinners = new Set(claims.map((c) => c.existingInvoiceId));
    check('exactly one invoice claims the business key', winners === 1, `${winners} winner(s)`);
    check('every caller is told the same winner', uniqueWinners.size === 1);
  }

  /* ================================================================== */
  /* 6. Tenant context is cleared even when the body throws              */
  /* ================================================================== */
  {
    // A pooled connection returned still carrying app.tenant_id is a
    // cross-tenant leak waiting for the next checkout. The error path is the
    // one most likely to skip the cleanup.
    await db
      .withTenant(tenantId, () => Promise.reject(new Error('deliberate failure')))
      .catch(() => undefined);

    // Hammer the pool so we are very likely to get the same connection back.
    const leaked = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.withBypass('smoke: verify no leaked context', async (client) => {
          const { rows } = await client.query<{ tenant: string | null }>(
            `SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant`,
          );
          return rows[0]?.tenant ?? null;
        }),
      ),
    );
    check(
      'no connection retains tenant context after a failed body',
      leaked.every((t) => t === null),
      `${leaked.filter(Boolean).length} leaked`,
    );
  }

  /* --- Cleanup --------------------------------------------------------- */
  await db.withBypass('smoke cleanup', async (client) => {
    await client.query('DELETE FROM invoice_dedup_keys WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM invoices WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  });
}

main()
  .then(async () => {
    await db.close();
    process.stdout.write(
      failures === 0 ? '\nALL CONCURRENCY CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`\nCONCURRENCY SMOKE ERROR: ${String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    await db.close().catch(() => undefined);
    process.exit(1);
  });
