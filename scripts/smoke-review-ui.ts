/**
 * Review UI smoke test.
 *
 * The review queue renders vendor names and line descriptions that came out of
 * third-party PDFs. That is untrusted input reaching an HTML document, so the
 * escaping is a security control and it is verified against a real row that
 * round-tripped through Postgres — not against a string literal in a unit test.
 *
 * Run against the compose stack: `pnpm smoke:ui`
 */

import { randomUUID } from 'node:crypto';
import { asTenantId, loadConfig } from '@onelineflow/core';
import { Database } from '@onelineflow/db';
import { escapeHtml, renderMoney } from '../services/api/src/routes/review-ui.js';

const cfg = loadConfig();
const db = new Database({
  connectionString: cfg.DATABASE_URL,
  max: 4,
  statementTimeoutMs: 15_000,
  applicationName: 'onelineflow-smoke-ui',
});

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

/** Payloads a hostile or merely broken vendor document could carry. */
const HOSTILE_VENDOR = '<script>alert("pwn")</script> & "quoted" O\'Brien Ltd';
const HOSTILE_FINDING = 'Confidence below <b>threshold</b> — see <a href="evil">here</a>';

async function main(): Promise<void> {
  const tenantId = asTenantId(randomUUID());

  await db.withBypass('ui smoke seed', async (client) => {
    await client.query(`INSERT INTO tenants (id, slug, display_name) VALUES ($1, $2, 'UI Smoke')`, [
      tenantId,
      `ui-${tenantId.slice(0, 8)}`,
    ]);
    await client.query(
      `INSERT INTO invoices
         (tenant_id, status, vendor_name, invoice_number, currency, total_minor,
          overall_confidence, findings, extraction_models)
       VALUES ($1,'needs_review',$2,'INV-XSS','USD',123456,0.42,$3::jsonb,ARRAY['m1','m2'])`,
      [
        tenantId,
        HOSTILE_VENDOR,
        JSON.stringify([
          { code: 'LOW_CONFIDENCE', severity: 'blocking', message: HOSTILE_FINDING },
        ]),
      ],
    );
  });

  const rows = await db.withTenant(tenantId, async (client) => {
    const result = await client.query<{
      vendor_name: string;
      total_minor: bigint;
      currency: string;
      findings: Array<{ message: string }>;
    }>(
      `SELECT vendor_name, total_minor, currency, findings
         FROM invoices WHERE status = 'needs_review'`,
    );
    return result.rows;
  });

  check('seeded invoice is visible to its tenant', rows.length === 1);
  const row = rows[0];
  if (!row) throw new Error('seed failed');

  // Stored verbatim: the database must not be sanitising. Escaping belongs at
  // render time, so the stored value stays faithful to the source document.
  check('hostile vendor name stored verbatim', row.vendor_name === HOSTILE_VENDOR);

  const escapedVendor = escapeHtml(row.vendor_name);
  check('script tag neutralised', !escapedVendor.includes('<script'));
  check('closing tag neutralised', !escapedVendor.includes('</'));
  check(
    'double quotes escaped so attributes cannot be broken out of',
    !escapedVendor.includes('"') && escapedVendor.includes('&quot;'),
  );
  check('single quotes escaped', !escapedVendor.includes("'") && escapedVendor.includes('&#39;'));
  check(
    'ampersand escaped exactly once',
    escapedVendor.includes('&amp;') && !escapedVendor.includes('&amp;amp;'),
  );

  const escapedFinding = escapeHtml(row.findings[0]?.message);
  check('markup inside a finding is neutralised', !escapedFinding.includes('<a href'));

  // The reviewer approves a payment based on this string. It must be exact.
  check(
    'amount renders exactly from bigint minor units',
    renderMoney(row.total_minor, row.currency) === '1234.56 USD',
    renderMoney(row.total_minor, row.currency),
  );

  await db.withBypass('ui smoke cleanup', async (client) => {
    await client.query('DELETE FROM invoices WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  });
}

main()
  .then(async () => {
    await db.close();
    process.stdout.write(
      failures === 0 ? '\nALL REVIEW UI CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`\nREVIEW UI SMOKE ERROR: ${String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    await db.close().catch(() => undefined);
    process.exit(1);
  });
