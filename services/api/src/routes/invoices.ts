/**
 * Invoice review and approval.
 *
 * Approval is the moment a human takes responsibility for a payment. Everything
 * here is built around three rules:
 *
 *   1. **The approver's limit is enforced server-side**, from the database, not
 *      from the token. A client that hides the Approve button is not a control.
 *   2. **Blocking findings cannot be approved away silently.** An approver may
 *      override, but the override is explicit, reasoned, and audited.
 *   3. **Approval and enqueueing are one transaction**, via the outbox. An
 *      invoice marked approved with no posting job is an invoice that quietly
 *      never gets paid.
 */

import { z } from 'zod';
import {
  ConflictError,
  hasBlockingFinding,
  Money,
  NotFoundError,
  ValidationError,
  asInvoiceId,
  type ValidationFinding,
} from '@onelineflow/core';
import { enqueueOutbox } from '@onelineflow/db';
import { invoiceTransitions } from '@onelineflow/observability';
import type { AppInstance } from '../app-types.js';
import type { ApiDeps } from '../main.js';
import { assertWithinApprovalLimit, requireTenant } from '../auth.js';

/** Shape of the columns the list query selects. Kept next to the SQL. */
interface InvoiceRow {
  id: string;
  created_at: Date;
  status: string;
  version: number;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  total_minor: bigint | null;
  overall_confidence: string | null;
  findings: unknown;
  qbo_entity_id: string | null;
  posted_at: Date | null;
}

const listQuery = z.object({
  status: z
    .enum([
      'received',
      'extracting',
      'extracted',
      'needs_review',
      'pending_approval',
      'approved',
      'posting',
      'posted',
      'failed',
      'rejected',
      'voided',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime().optional(),
});

const approveBody = z.object({
  /**
   * Required when the invoice carries blocking findings. Forcing a written
   * reason is what turns "clicked through a warning" into an auditable decision.
   */
  overrideReason: z.string().min(10).max(1000).optional(),
  /** Optimistic concurrency from the client's last read. */
  expectedVersion: z.number().int().positive().optional(),
});

const rejectBody = z.object({
  reason: z.string().min(3).max(1000),
});

export function registerInvoiceRoutes(app: AppInstance, deps: ApiDeps): void {
  /* ------------------------------------------------------------------ */
  /* List                                                                */
  /* ------------------------------------------------------------------ */
  app.get('/v1/invoices', async (req, reply) => {
    const auth = await requireTenant(req, ['viewer']);
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '), {
        publicMessage: 'Invalid list parameters.',
      });
    }
    const { status, limit, cursor } = parsed.data;

    const rows = await deps.db.withTenant(auth.tenantId, async (client) => {
      // Keyset pagination on created_at. OFFSET degrades linearly and this
      // table is partitioned by created_at, so a cursor also prunes partitions.
      const result = await client.query<InvoiceRow>(
        `SELECT id, created_at, status, version, vendor_name, invoice_number,
                invoice_date, due_date, currency, total_minor, overall_confidence,
                findings, qbo_entity_id, posted_at
           FROM invoices
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::timestamptz IS NULL OR created_at < $2)
          ORDER BY created_at DESC
          LIMIT $3`,
        [status ?? null, cursor ?? null, limit],
      );
      return result.rows;
    });

    const last = rows.at(-1);
    return reply.send({
      invoices: rows.map(serialiseInvoice),
      // Only advertise a cursor on a full page; a short page is the end.
      nextCursor: rows.length === limit && last ? last.created_at.toISOString() : null,
    });
  });

  /* ------------------------------------------------------------------ */
  /* Get one                                                             */
  /* ------------------------------------------------------------------ */
  app.get<{ Params: { id: string } }>('/v1/invoices/:id', async (req, reply) => {
    const auth = await requireTenant(req, ['viewer']);
    const invoiceId = asInvoiceId(req.params.id);

    const result = await deps.db.withTenant(auth.tenantId, async (client) => {
      const inv = await client.query(
        `SELECT id, created_at, status, version, vendor_name, invoice_number,
                invoice_date, due_date, currency, total_minor, subtotal_minor,
                tax_total_minor, overall_confidence, extraction_models, findings,
                qbo_entity_id, qbo_doc_number, posted_at, failure_code,
                failure_message, approved_by, approved_at, rejected_reason
           FROM invoices WHERE id = $1`,
        [invoiceId],
      );
      if (!inv.rows[0]) return null;

      const lines = await client.query(
        `SELECT line_number, description, amount_minor, gl_code, tax_code, confidence
           FROM invoice_line_items
          WHERE invoice_id = $1
          ORDER BY line_number`,
        [invoiceId],
      );
      return { invoice: inv.rows[0], lines: lines.rows };
    });

    if (!result) throw new NotFoundError(`Invoice ${invoiceId} not found`);

    return reply.send({
      ...serialiseInvoice(result.invoice),
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- row boundary */
      lineItems: result.lines.map((l: any) => ({
        lineNumber: l.line_number,
        description: l.description,
        amount: minorToDecimal(l.amount_minor, result.invoice.currency),
        glCode: l.gl_code,
        taxCode: l.tax_code,
        confidence: l.confidence === null ? null : Number(l.confidence),
      })),
    });
  });

  /* ------------------------------------------------------------------ */
  /* Approve                                                             */
  /* ------------------------------------------------------------------ */
  app.post<{ Params: { id: string } }>('/v1/invoices/:id/approve', async (req, reply) => {
    const auth = await requireTenant(req, ['approver']);
    const invoiceId = asInvoiceId(req.params.id);

    const parsed = approveBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '), {
        publicMessage: 'Invalid approval request.',
      });
    }
    const { overrideReason, expectedVersion } = parsed.data;

    const outcome = await deps.db.withTenant(auth.tenantId, async (client) =>
      deps.db.transaction(client, async (tx) => {
        // FOR UPDATE: serialise two approvers clicking at the same moment. The
        // CAS in transitionStatus would catch it anyway, but taking the row lock
        // turns a confusing 409 into a clean queue of one.
        const { rows } = await tx.query(
          `SELECT id, created_at, status, version, total_minor, currency,
                  findings, vendor_name, invoice_number
             FROM invoices WHERE id = $1 FOR UPDATE`,
          [invoiceId],
        );
        const inv = rows[0];
        if (!inv) throw new NotFoundError(`Invoice ${invoiceId} not found`);

        if (expectedVersion !== undefined && inv.version !== expectedVersion) {
          throw new ConflictError(
            `Invoice changed since you loaded it (v${String(inv.version)} vs v${String(expectedVersion)})`,
            { publicMessage: 'This invoice changed while you were reviewing it. Reload.' },
          );
        }

        if (inv.status === 'approved' || inv.status === 'posting' || inv.status === 'posted') {
          // Idempotent: approving twice is a double-click, not an error.
          return { alreadyApproved: true, status: inv.status as string, invoice: inv };
        }
        if (inv.status !== 'pending_approval' && inv.status !== 'needs_review') {
          throw new ConflictError(`Cannot approve an invoice in status '${String(inv.status)}'`, {
            publicMessage: `This invoice is not awaiting approval (it is ${String(inv.status)}).`,
          });
        }

        // --- Approval limit, enforced from the database -----------------
        if (inv.total_minor === null || inv.currency === null) {
          throw new ValidationError('Invoice has no total; it cannot be approved', {
            publicMessage: 'This invoice has no amount yet.',
          });
        }
        assertWithinApprovalLimit(auth, BigInt(inv.total_minor));

        // --- Blocking findings need an explicit, reasoned override -------
        const findings = (inv.findings ?? []) as ValidationFinding[];
        if (hasBlockingFinding(findings) && !overrideReason) {
          const blocking = findings.filter((f) => f.severity === 'blocking');
          throw new ValidationError(
            `Invoice has ${blocking.length} blocking finding(s) and no override reason`,
            {
              publicMessage:
                'This invoice has blocking issues. Provide an override reason to approve it anyway.',
              field: 'overrideReason',
              context: { codes: blocking.map((f) => f.code) },
            },
          );
        }

        const updated = await deps.invoices.transitionStatus(tx, {
          id: invoiceId,
          createdAt: inv.created_at,
          from: inv.status,
          to: 'approved',
          expectedVersion: inv.version,
          patch: {
            approved_by: auth.userId,
            approved_at: new Date(),
            rejected_reason: null,
          },
        });
        invoiceTransitions.inc({ from: String(inv.status), to: 'approved' });

        // Same transaction as the state change. This is the whole point of the
        // outbox: "approved" and "queued to post" cannot diverge.
        await enqueueOutbox(tx, auth.tenantId, {
          aggregateType: 'invoice',
          aggregateId: invoiceId,
          eventType: 'invoice.approved',
          payload: {
            invoiceCreatedAt: inv.created_at.toISOString(),
            expectedVersion: updated.version,
            approvedBy: auth.userId,
          },
        });

        await tx.query(
          `INSERT INTO audit_log
             (tenant_id, actor_type, actor_id, action, entity_type, entity_id, before, after, context)
           VALUES ($1,'user',$2,'invoice.approved','invoice',$3,$4::jsonb,$5::jsonb,$6::jsonb)`,
          [
            auth.tenantId,
            auth.userId,
            invoiceId,
            JSON.stringify({ status: inv.status }),
            JSON.stringify({ status: 'approved' }),
            JSON.stringify({
              totalMinor: String(inv.total_minor),
              currency: inv.currency,
              role: auth.role,
              // Recorded explicitly so an auditor can find every override.
              overrideReason: overrideReason ?? null,
              overrodeBlocking: hasBlockingFinding(findings),
            }),
          ],
        );

        return { alreadyApproved: false, status: 'approved', invoice: updated };
      }),
    );

    return reply.send({
      invoiceId,
      status: outcome.status,
      alreadyApproved: outcome.alreadyApproved,
    });
  });

  /* ------------------------------------------------------------------ */
  /* Reject                                                              */
  /* ------------------------------------------------------------------ */
  app.post<{ Params: { id: string } }>('/v1/invoices/:id/reject', async (req, reply) => {
    const auth = await requireTenant(req, ['approver']);
    const invoiceId = asInvoiceId(req.params.id);

    const parsed = rejectBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('A rejection reason is required', {
        publicMessage: 'Please say why this invoice is being rejected.',
        field: 'reason',
      });
    }

    await deps.db.withTenant(auth.tenantId, async (client) =>
      deps.db.transaction(client, async (tx) => {
        const { rows } = await tx.query(
          `SELECT id, created_at, status, version FROM invoices WHERE id = $1 FOR UPDATE`,
          [invoiceId],
        );
        const inv = rows[0];
        if (!inv) throw new NotFoundError(`Invoice ${invoiceId} not found`);

        if (inv.status === 'rejected') return; // idempotent

        // Rejecting something already in the ledger is not a rejection, it is a
        // reversal, and that is a different operation with different accounting.
        if (inv.status === 'posted' || inv.status === 'posting') {
          throw new ConflictError('Cannot reject an invoice already posted to QuickBooks', {
            publicMessage:
              'This invoice is already in QuickBooks. Void it there, or raise a vendor credit.',
          });
        }

        await deps.invoices.transitionStatus(tx, {
          id: invoiceId,
          createdAt: inv.created_at,
          from: inv.status,
          to: 'rejected',
          expectedVersion: inv.version,
          patch: { rejected_reason: parsed.data.reason, next_retry_at: null },
        });
        invoiceTransitions.inc({ from: String(inv.status), to: 'rejected' });

        await enqueueOutbox(tx, auth.tenantId, {
          aggregateType: 'invoice',
          aggregateId: invoiceId,
          eventType: 'invoice.rejected',
          payload: { reason: parsed.data.reason, rejectedBy: auth.userId },
        });

        await tx.query(
          `INSERT INTO audit_log
             (tenant_id, actor_type, actor_id, action, entity_type, entity_id, before, after, context)
           VALUES ($1,'user',$2,'invoice.rejected','invoice',$3,$4::jsonb,$5::jsonb,$6::jsonb)`,
          [
            auth.tenantId,
            auth.userId,
            invoiceId,
            JSON.stringify({ status: inv.status }),
            JSON.stringify({ status: 'rejected' }),
            JSON.stringify({ reason: parsed.data.reason, role: auth.role }),
          ],
        );
      }),
    );

    return reply.send({ invoiceId, status: 'rejected' });
  });
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Money crosses the API boundary as an exact decimal STRING plus the currency,
 * never as a JSON number. A JS client parsing 1234.55 into a double and
 * rendering it back is how a penny goes missing in a UI.
 */
function minorToDecimal(minor: bigint | string | null, currency: string | null): string | null {
  if (minor === null || currency === null) return null;
  return Money.fromMinor(minor, currency).toDecimalString();
}

/* eslint-disable @typescript-eslint/no-explicit-any -- row mapping boundary */
function serialiseInvoice(row: any): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    status: row.status,
    version: row.version,
    vendorName: row.vendor_name,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    currency: row.currency,
    total: minorToDecimal(row.total_minor, row.currency),
    subtotal: minorToDecimal(row.subtotal_minor ?? null, row.currency),
    taxTotal: minorToDecimal(row.tax_total_minor ?? null, row.currency),
    confidence: row.overall_confidence === null ? null : Number(row.overall_confidence),
    models: row.extraction_models ?? undefined,
    findings: row.findings ?? [],
    qboEntityId: row.qbo_entity_id,
    qboDocNumber: row.qbo_doc_number,
    postedAt: row.posted_at?.toISOString?.() ?? row.posted_at ?? null,
    approvedAt: row.approved_at?.toISOString?.() ?? row.approved_at ?? null,
    failureCode: row.failure_code ?? null,
    failureMessage: row.failure_message ?? null,
    rejectedReason: row.rejected_reason ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
