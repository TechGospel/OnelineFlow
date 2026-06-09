/**
 * Posting an approved invoice to QuickBooks Online.
 *
 * This is the only code in the platform that creates a financial record in a
 * customer's ledger. Its correctness requirement is therefore stronger than
 * "usually works": it must be impossible for one logical invoice to become two
 * bills, under any interleaving of crashes, retries and concurrent workers.
 *
 * The guarantee is built from four layers:
 *
 *   1. CAS claim      — `approved -> posting` with an expected version. Exactly
 *                       one worker wins; the losers get a ConflictError.
 *   2. Stored entity  — if `qbo_entity_id` is already set, we are done. Return.
 *   3. Intuit requestid — deterministic per (invoice, epoch), so a retry of a
 *                       request Intuit already committed returns the SAME bill
 *                       rather than creating another.
 *   4. Recovery query — if the outcome is genuinely unknown (timeout, crash),
 *                       we ASK QuickBooks what happened before doing anything.
 *
 * Layer 4 is what makes the timeout case safe, and it is the layer most
 * implementations omit.
 */

import {
  ConflictError,
  Money,
  qboRequestId,
  toAppError,
  ValidationError,
  type InvoiceId,
  type RealmId,
  type TenantId,
} from '@onelineflow/core';
import {
  enqueueOutbox,
  type Database,
  type InvoiceRepository,
  type ConnectionRepository,
  type QboConnectionWithTokens,
} from '@onelineflow/db';
import {
  escapeQboLiteral,
  mapToBill,
  type QboBill,
  type QboClient,
  type QboRef,
  type ReferenceResolver,
} from '@onelineflow/qbo';
import { duplicatePostsPrevented, qboRequests } from '@onelineflow/observability';
import type { Logger } from '@onelineflow/observability';
import type pg from 'pg';
import { extractedInvoiceSchema } from '@onelineflow/core';

export interface PostInvoiceDeps {
  readonly db: Database;
  readonly invoices: InvoiceRepository;
  readonly connections: ConnectionRepository;
  readonly qbo: QboClient;
  readonly references: ReferenceResolver;
  readonly logger: Logger;
}

export interface PostInvoiceParams {
  readonly tenantId: TenantId;
  readonly invoiceId: InvoiceId;
  readonly invoiceCreatedAt: Date;
  readonly realmId: RealmId;
  readonly signal?: AbortSignal;
}

export interface PostInvoiceOutcome {
  readonly status: 'posted' | 'already_posted' | 'recovered' | 'parked';
  readonly qboEntityId?: string;
  readonly reason?: string;
}

export async function postInvoice(
  deps: PostInvoiceDeps,
  params: PostInvoiceParams,
): Promise<PostInvoiceOutcome> {
  const { db, invoices, connections, qbo, logger } = deps;
  const log = logger.child({ invoiceId: params.invoiceId, realmId: params.realmId });

  return db.withTenant(params.tenantId, async (client) => {
    const invoice = await invoices.requireById(client, params.invoiceId);

    /* --- Guard 2: already posted --------------------------------------- */
    if (invoice.qboEntityId) {
      duplicatePostsPrevented.inc({ guard: 'stored_entity_id' });
      log.info({ qboEntityId: invoice.qboEntityId }, 'invoice already posted; nothing to do');
      return { status: 'already_posted', qboEntityId: invoice.qboEntityId };
    }

    const requestId = qboRequestId(
      params.tenantId,
      params.invoiceId,
      'create-bill',
      invoice.postAttemptEpoch,
    );

    /* --- Guard 4: recover an unknown outcome ---------------------------- */
    // Reaching `posting` without an entity id means a previous attempt died
    // mid-flight. Intuit may or may not have committed it. Asking is the only
    // safe move — a blind retry here is exactly how duplicates get created.
    if (invoice.status === 'posting') {
      const connection = await connections.findActive(client, params.tenantId, params.realmId);
      const existing = await findBillByDocNumber(
        client,
        qbo,
        { tenantId: params.tenantId, realmId: params.realmId, invoiceId: params.invoiceId },
        connection,
        invoice.invoiceNumber,
        params.signal,
      );

      if (existing) {
        duplicatePostsPrevented.inc({ guard: 'recovery_query' });
        log.warn(
          { qboEntityId: existing.Id },
          'recovered an in-flight post: the bill already exists in QuickBooks',
        );
        await invoices.recordPosted(client, {
          id: params.invoiceId,
          createdAt: params.invoiceCreatedAt,
          expectedVersion: invoice.version,
          realmId: params.realmId,
          entityType: 'Bill',
          entityId: existing.Id,
          syncToken: existing.SyncToken,
          docNumber: existing.DocNumber ?? null,
        });
        return { status: 'recovered', qboEntityId: existing.Id };
      }
      // No bill found: the previous attempt genuinely did not land. Fall through
      // and post, reusing the same requestId.
      log.info('previous attempt left no bill in QuickBooks; re-posting');
    } else {
      /* --- Guard 1: CAS claim ------------------------------------------ */
      await invoices.transitionStatus(client, {
        id: params.invoiceId,
        createdAt: params.invoiceCreatedAt,
        from: 'approved',
        to: 'posting',
        expectedVersion: invoice.version,
      });
    }

    // Re-read so we carry the version produced by the claim.
    const claimed = await invoices.requireById(client, params.invoiceId);
    const connection = await connections.findActive(client, params.tenantId, params.realmId);

    /* --- Build the payload --------------------------------------------- */
    let bill: QboBill;
    try {
      bill = await buildBill(client, deps, params, claimed, connection);
    } catch (err) {
      const appErr = toAppError(err);
      // A mapping failure is permanent — the same input will fail identically.
      // Park it for a human rather than burning retries.
      await parkInvoice(client, deps, params, claimed.version, appErr.message, appErr.category);
      log.warn({ err: appErr }, 'parked invoice: could not build a valid QBO payload');
      return { status: 'parked', reason: appErr.publicMessage };
    }

    /* --- Post ----------------------------------------------------------- */
    try {
      const res = await qbo.request<{
        Bill: { Id: string; SyncToken: string; DocNumber?: string };
      }>(
        client,
        { tenantId: params.tenantId, realmId: params.realmId, invoiceId: params.invoiceId },
        connection,
        {
          method: 'POST',
          path: '/bill',
          body: bill,
          requestId, // Guard 3.
          ...(params.signal !== undefined ? { signal: params.signal } : {}),
        },
      );

      const created = res.Bill;
      if (!created?.Id) {
        throw new ValidationError('QuickBooks accepted the request but returned no Bill.Id');
      }

      await db.transaction(client, async (tx) => {
        await invoices.recordPosted(tx, {
          id: params.invoiceId,
          createdAt: params.invoiceCreatedAt,
          expectedVersion: claimed.version,
          realmId: params.realmId,
          entityType: 'Bill',
          entityId: created.Id,
          syncToken: created.SyncToken,
          docNumber: created.DocNumber ?? null,
        });
        await enqueueOutbox(tx, params.tenantId, {
          aggregateType: 'invoice',
          aggregateId: params.invoiceId,
          eventType: 'invoice.posted',
          payload: { qboEntityId: created.Id, realmId: params.realmId },
        });
      });

      qboRequests.inc({ method: 'POST', entity: 'Bill', outcome: 'success', fault_code: '' });
      log.info({ qboEntityId: created.Id }, 'invoice posted to QuickBooks');
      return { status: 'posted', qboEntityId: created.Id };
    } catch (err) {
      const appErr = toAppError(err);
      qboRequests.inc({
        method: 'POST',
        entity: 'Bill',
        outcome: 'failure',
        fault_code: stringifyCode(appErr.context['qboCode']) ?? appErr.category,
      });

      /* --- Duplicate: reconcile rather than re-post --------------------- */
      if (appErr instanceof ConflictError && appErr.context['qboCode'] === '6240') {
        duplicatePostsPrevented.inc({ guard: 'qbo_duplicate_fault' });
        const existing = await findBillByDocNumber(
          client,
          qbo,
          { tenantId: params.tenantId, realmId: params.realmId, invoiceId: params.invoiceId },
          connection,
          claimed.invoiceNumber,
          params.signal,
        );
        if (existing) {
          await invoices.recordPosted(client, {
            id: params.invoiceId,
            createdAt: params.invoiceCreatedAt,
            expectedVersion: claimed.version,
            realmId: params.realmId,
            entityType: 'Bill',
            entityId: existing.Id,
            syncToken: existing.SyncToken,
            docNumber: existing.DocNumber ?? null,
          });
          log.warn({ qboEntityId: existing.Id }, 'linked to the pre-existing duplicate bill');
          return { status: 'recovered', qboEntityId: existing.Id };
        }
      }

      if (!appErr.retryable) {
        await parkInvoice(client, deps, params, claimed.version, appErr.message, appErr.category);
        log.warn({ err: appErr }, 'parked invoice: permanent QuickBooks failure');
        return { status: 'parked', reason: appErr.publicMessage };
      }

      // Retryable: leave the invoice in `posting`. The next attempt enters via
      // the recovery path above, which is safe by construction.
      log.warn({ err: appErr }, 'transient failure; will retry');
      throw appErr;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface QboBillRecord {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
}

/**
 * Ask QuickBooks whether a bill with this DocNumber already exists.
 *
 * This is the recovery oracle. It is only as good as DocNumber uniqueness, which
 * is why the mapper preserves the invoice number's tail and why we additionally
 * carry the invoice id in PrivateNote — a human reconciling an edge case can
 * always trace the record back.
 */
async function findBillByDocNumber(
  client: pg.PoolClient,
  qbo: QboClient,
  ctx: { tenantId: TenantId; realmId: RealmId; invoiceId: InvoiceId },
  connection: QboConnectionWithTokens,
  invoiceNumber: string | null,
  signal?: AbortSignal,
): Promise<QboBillRecord | null> {
  if (!invoiceNumber) return null;
  const docNumber = invoiceNumber.slice(-21);

  const rows = await qbo.query<QboBillRecord>(
    client,
    ctx,
    connection,
    `select Id, SyncToken, DocNumber from Bill where DocNumber = '${escapeQboLiteral(docNumber)}' maxresults 2`,
    signal,
  );

  // More than one match means DocNumber is not unique in this realm, so it
  // cannot serve as our oracle. Refuse to guess; a human must reconcile.
  if (rows.length !== 1) return null;
  return rows[0] ?? null;
}

async function buildBill(
  client: pg.PoolClient,
  deps: PostInvoiceDeps,
  params: PostInvoiceParams,
  invoice: { version: number; currency: string | null },
  connection: QboConnectionWithTokens,
): Promise<QboBill> {
  const { rows } = await client.query<{ extraction: unknown; settings: { homeCurrency?: string } }>(
    `SELECT i.extraction, coalesce(t.settings, '{}'::jsonb) AS settings
       FROM invoices i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.id = $1 AND i.created_at = $2`,
    [params.invoiceId, params.invoiceCreatedAt],
  );

  const raw = rows[0]?.extraction;
  if (!raw) {
    throw new ValidationError('Invoice has no stored extraction to post', {
      publicMessage: 'This invoice has not been extracted yet.',
    });
  }
  const extracted = extractedInvoiceSchema.parse(raw);

  const ctx = {
    tenantId: params.tenantId,
    realmId: params.realmId,
    invoiceId: params.invoiceId,
  };

  const vendor = await deps.references.resolve(
    client,
    ctx,
    connection,
    'Vendor',
    extracted.vendorName,
    {
      allowFuzzy: true,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    },
  );
  const vendorRef: QboRef = { value: vendor.qboId, name: vendor.displayName };

  // Resolve one account per line. Sequential rather than parallel on purpose:
  // the rate limiter is per-realm, so firing 500 lookups concurrently only
  // queues them behind each other while holding 500 promises open.
  const lineAccountRefs: QboRef[] = [];
  for (const line of extracted.lineItems) {
    const glCode = line.glCode ?? (await defaultExpenseAccount(client, params.tenantId));
    const account = await deps.references.resolve(client, ctx, connection, 'Account', glCode, {
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
    lineAccountRefs.push({ value: account.qboId, name: account.displayName });
  }

  const { bill, findings } = mapToBill({
    extracted,
    vendorRef,
    lineAccountRefs,
    privateNote: `onelineFlow invoice ${params.invoiceId}`,
    homeCurrency: rows[0]?.settings?.homeCurrency ?? invoice.currency ?? extracted.currency,
  });

  if (findings.length > 0) {
    await client.query(
      `UPDATE invoices SET findings = findings || $1::jsonb
        WHERE id = $2 AND created_at = $3`,
      [JSON.stringify(findings), params.invoiceId, params.invoiceCreatedAt],
    );
  }

  // Belt and braces: re-verify the arithmetic on the payload we are about to
  // send, independently of the mapper that produced it.
  const lineSum = Money.sum(
    bill.Line.map((l) => Money.fromDecimalString(l.Amount.toFixed(2), extracted.currency)),
    extracted.currency,
  );
  const declared = Money.fromDecimalString(extracted.total, extracted.currency);
  if (!lineSum.equals(declared) && !findings.some((f) => f.code === 'LINES_NET_OF_TAX')) {
    throw new ValidationError(
      `Payload line sum ${lineSum.toString()} does not equal the invoice total ${declared.toString()}`,
    );
  }

  return bill;
}

async function defaultExpenseAccount(client: pg.PoolClient, tenantId: TenantId): Promise<string> {
  const { rows } = await client.query<{ acct: string | null }>(
    `SELECT settings->>'defaultExpenseAccount' AS acct FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const acct = rows[0]?.acct;
  if (!acct) {
    throw new ValidationError('No GL code on the line and no tenant default expense account', {
      publicMessage:
        'This line has no account code and no default is configured. Set one in Settings.',
      field: 'glCode',
    });
  }
  return acct;
}

async function parkInvoice(
  client: pg.PoolClient,
  deps: PostInvoiceDeps,
  params: PostInvoiceParams,
  expectedVersion: number,
  message: string,
  code: string,
): Promise<void> {
  await deps.db.transaction(client, async (tx) => {
    await deps.invoices.transitionStatus(tx, {
      id: params.invoiceId,
      createdAt: params.invoiceCreatedAt,
      from: 'posting',
      to: 'failed',
      expectedVersion,
      patch: {
        failure_code: code,
        failure_message: message.slice(0, 2000),
        next_retry_at: null,
      },
    });
    await enqueueOutbox(tx, params.tenantId, {
      aggregateType: 'invoice',
      aggregateId: params.invoiceId,
      eventType: 'invoice.posting_failed',
      payload: { code, message: message.slice(0, 500) },
    });
  });
}

/**
 * QBO fault codes arrive through `AppError.context`, which is typed `unknown`.
 * Narrow explicitly rather than calling String() on an arbitrary value — that
 * would silently produce "[object Object]" as a metric label.
 */
function stringifyCode(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}
