/**
 * Invoice persistence.
 *
 * Two rules run through every method here:
 *
 *   1. State changes go through `transitionStatus`, which enforces the state
 *      machine AND optimistic concurrency in a single UPDATE. Zero rows affected
 *      means someone else moved the invoice; the caller must re-read, never
 *      blindly retry.
 *   2. Anything that must happen "along with" a state change — enqueueing a job,
 *      emitting an event — is written to the outbox in the SAME transaction.
 *      There are no dual writes.
 */

import type pg from 'pg';
import {
  assertTransition,
  ConflictError,
  Money,
  NotFoundError,
  type ExtractedInvoice,
  type InvoiceId,
  type InvoiceStatus,
  type TenantId,
  type ValidationFinding,
} from '@onelineflow/core';

export interface InvoiceRow {
  id: InvoiceId;
  tenantId: TenantId;
  createdAt: Date;
  status: InvoiceStatus;
  version: number;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  totalMinor: bigint | null;
  overallConfidence: string | null;
  businessKey: string | null;
  qboRealmId: string | null;
  qboEntityId: string | null;
  qboSyncToken: string | null;
  postAttemptEpoch: number;
  retryCount: number;
  findings: ValidationFinding[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- row mapping boundary */
function mapRow(r: any): InvoiceRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    createdAt: r.created_at,
    status: r.status,
    version: r.version,
    vendorName: r.vendor_name,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    currency: r.currency,
    totalMinor: r.total_minor,
    overallConfidence: r.overall_confidence,
    businessKey: r.business_key,
    qboRealmId: r.qbo_realm_id,
    qboEntityId: r.qbo_entity_id,
    qboSyncToken: r.qbo_sync_token,
    postAttemptEpoch: r.post_attempt_epoch,
    retryCount: r.retry_count,
    findings: r.findings ?? [],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const SELECT_COLUMNS = `
  id, tenant_id, created_at, status, version, vendor_name, invoice_number,
  invoice_date, due_date, currency, total_minor, overall_confidence,
  business_key, qbo_realm_id, qbo_entity_id, qbo_sync_token,
  post_attempt_epoch, retry_count, findings`;

export class InvoiceRepository {
  async findById(client: pg.PoolClient, id: InvoiceId): Promise<InvoiceRow | null> {
    const { rows } = await client.query(`SELECT ${SELECT_COLUMNS} FROM invoices WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async requireById(client: pg.PoolClient, id: InvoiceId): Promise<InvoiceRow> {
    const row = await this.findById(client, id);
    if (!row) throw new NotFoundError(`Invoice ${id} not found`);
    return row;
  }

  /**
   * Claim a business key. Returns the existing invoice id when the key is
   * already taken, which is how ingestion stays idempotent under retries.
   */
  async claimBusinessKey(
    client: pg.PoolClient,
    tenantId: TenantId,
    businessKey: string,
    invoiceId: InvoiceId,
  ): Promise<{ claimed: boolean; existingInvoiceId: InvoiceId }> {
    const { rows } = await client.query<{ invoice_id: InvoiceId }>(
      `INSERT INTO invoice_dedup_keys (tenant_id, business_key, invoice_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, business_key) DO UPDATE
         SET business_key = EXCLUDED.business_key
       RETURNING invoice_id`,
      [tenantId, businessKey, invoiceId],
    );
    const winner = rows[0]?.invoice_id;
    /* istanbul ignore next -- RETURNING always yields a row here */
    if (!winner) throw new ConflictError('Dedup claim returned no row');
    return { claimed: winner === invoiceId, existingInvoiceId: winner };
  }

  /**
   * The single mutation point for status.
   *
   * `expectedVersion` makes this a compare-and-swap. Combined with the state
   * machine check, two workers racing on the same invoice produce exactly one
   * winner and one ConflictError — never two QBO posts.
   */
  async transitionStatus(
    client: pg.PoolClient,
    params: {
      id: InvoiceId;
      createdAt: Date;
      from: InvoiceStatus;
      to: InvoiceStatus;
      expectedVersion: number;
      patch?: Readonly<Record<string, unknown>>;
    },
  ): Promise<InvoiceRow> {
    assertTransition(params.from, params.to);

    const patch = params.patch ?? {};
    const assignments: string[] = ['status = $1', 'version = version + 1', 'updated_at = now()'];
    const values: unknown[] = [params.to];
    let i = 2;

    for (const [column, value] of Object.entries(patch)) {
      assertSafeColumn(column);
      assignments.push(`${column} = $${i}`);
      values.push(value);
      i += 1;
    }

    values.push(params.id, params.createdAt, params.expectedVersion, params.from);

    const { rows } = await client.query(
      `UPDATE invoices SET ${assignments.join(', ')}
        WHERE id = $${i} AND created_at = $${i + 1}
          AND version = $${i + 2} AND status = $${i + 3}
        RETURNING ${SELECT_COLUMNS}`,
      values,
    );

    if (!rows[0]) {
      throw new ConflictError(
        `Invoice ${params.id} was modified concurrently (expected version ` +
          `${params.expectedVersion} in status ${params.from})`,
        {
          publicMessage: 'This invoice changed while you were working on it. Reload and retry.',
          context: { invoiceId: params.id, from: params.from, to: params.to },
        },
      );
    }
    return mapRow(rows[0]);
  }

  /** Persist an extraction result and its line items in one transaction. */
  async saveExtraction(
    client: pg.PoolClient,
    params: {
      id: InvoiceId;
      tenantId: TenantId;
      createdAt: Date;
      extracted: ExtractedInvoice;
      total: Money;
      overallConfidence: number;
      models: readonly string[];
      costMicros: bigint;
      businessKey: string;
    },
  ): Promise<void> {
    const e = params.extracted;

    await client.query(
      `UPDATE invoices SET
         vendor_name = $1, vendor_tax_id = $2, invoice_number = $3,
         invoice_date = $4::date, due_date = $5::date, po_number = $6,
         currency = $7, total_minor = $8,
         subtotal_minor = $9, tax_total_minor = $10,
         extraction = $11::jsonb, field_confidence = $12::jsonb,
         overall_confidence = $13, extraction_models = $14,
         extraction_cost_micros = extraction_cost_micros + $15,
         business_key = $16, updated_at = now()
       WHERE id = $17 AND created_at = $18`,
      [
        e.vendorName,
        e.vendorTaxId ?? null,
        e.invoiceNumber,
        e.invoiceDate,
        e.dueDate ?? null,
        e.poNumber ?? null,
        e.currency,
        params.total.minor,
        e.subtotal ? Money.fromDecimalString(e.subtotal, e.currency).minor : null,
        e.taxTotal ? Money.fromDecimalString(e.taxTotal, e.currency).minor : null,
        JSON.stringify(e),
        JSON.stringify(e.fieldConfidence),
        params.overallConfidence,
        params.models,
        params.costMicros,
        params.businessKey,
        params.id,
        params.createdAt,
      ],
    );

    // Replace rather than append: a re-extraction must not double the lines.
    await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1 AND created_at = $2', [
      params.id,
      params.createdAt,
    ]);

    if (e.lineItems.length > 0) {
      // Single multi-row INSERT via UNNEST. At 500 lines this is one round trip
      // instead of 500 — the difference is measurable at our volume.
      await client.query(
        `INSERT INTO invoice_line_items
           (tenant_id, invoice_id, created_at, line_number, description,
            amount_minor, gl_code, tax_code, confidence)
         SELECT $1, $2, $3, * FROM unnest(
           $4::int[], $5::text[], $6::bigint[], $7::text[], $8::text[], $9::numeric[])`,
        [
          params.tenantId,
          params.id,
          params.createdAt,
          e.lineItems.map((_, idx) => idx),
          e.lineItems.map((l) => l.description),
          e.lineItems.map((l) => Money.fromDecimalString(l.amount, e.currency).minor),
          e.lineItems.map((l) => l.glCode ?? null),
          e.lineItems.map((l) => l.taxCode ?? null),
          e.lineItems.map((l) => l.confidence),
        ],
      );
    }
  }

  /**
   * Record a successful QBO post. Separate from `transitionStatus` only so the
   * caller can run both inside one transaction with the outbox write.
   */
  async recordPosted(
    client: pg.PoolClient,
    params: {
      id: InvoiceId;
      createdAt: Date;
      expectedVersion: number;
      realmId: string;
      entityType: 'Bill' | 'Purchase' | 'VendorCredit';
      entityId: string;
      syncToken: string;
      docNumber: string | null;
    },
  ): Promise<InvoiceRow> {
    return this.transitionStatus(client, {
      id: params.id,
      createdAt: params.createdAt,
      from: 'posting',
      to: 'posted',
      expectedVersion: params.expectedVersion,
      patch: {
        qbo_realm_id: params.realmId,
        qbo_entity_type: params.entityType,
        qbo_entity_id: params.entityId,
        qbo_sync_token: params.syncToken,
        qbo_doc_number: params.docNumber,
        posted_at: new Date(),
        failure_code: null,
        failure_message: null,
        next_retry_at: null,
      },
    });
  }
}

/**
 * Column names reach the SQL string directly (they cannot be parameterised), so
 * they are allow-listed by shape. Anything outside `[a-z_]` is rejected.
 */
const SAFE_COLUMN = /^[a-z][a-z0-9_]{0,62}$/;
function assertSafeColumn(column: string): void {
  if (!SAFE_COLUMN.test(column)) {
    throw new ConflictError(`Refusing to build SQL with unsafe column name: "${column}"`);
  }
}
