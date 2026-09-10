/**
 * Document ingestion.
 *
 * Idempotency at the front door: the same PDF submitted twice — by a retrying
 * client, by a vendor emailing two addresses, by an n8n workflow that fired
 * twice — produces ONE invoice. The content fingerprint is the claim, and the
 * unique index on (tenant_id, fingerprint) is what makes the claim atomic under
 * concurrency rather than merely usually-correct.
 */

import { z } from 'zod';
import { documentFingerprint, newUuid, ValidationError, type InvoiceId } from '@onelineflow/core';
import { enqueueOutbox } from '@onelineflow/db';
import { invoicesIngested } from '@onelineflow/observability';
import type { AppInstance } from '../app-types.js';
import type { ApiDeps } from '../main.js';
import { requireTenant } from '../auth.js';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/webp',
]);

const MAX_BYTES = 25 * 1024 * 1024;

const ingestBody = z.object({
  /** Base64 document bytes. Multipart is also supported in production. */
  content: z.string().min(1),
  contentType: z.string().min(1),
  filename: z.string().max(500).optional(),
  source: z.enum(['email', 'upload', 'api', 'zoho_creator', 'sftp']),
  sourceRef: z.string().max(500).optional(),
});

export function registerIngestRoutes(app: AppInstance, deps: ApiDeps): void {
  app.post('/v1/invoices', async (req, reply) => {
    const auth = await requireTenant(req, ['clerk']);

    const parsed = ingestBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '), {
        publicMessage: 'The upload was malformed.',
      });
    }
    const input = parsed.data;

    if (!ALLOWED_MIME.has(input.contentType)) {
      throw new ValidationError(`Unsupported content type ${input.contentType}`, {
        publicMessage: 'Only PDF, PNG, JPEG, TIFF and WebP invoices are accepted.',
        field: 'contentType',
      });
    }

    const bytes = Buffer.from(input.content, 'base64');
    if (bytes.length === 0) {
      throw new ValidationError('Document is empty', { field: 'content' });
    }
    if (bytes.length > MAX_BYTES) {
      throw new ValidationError(`Document is ${bytes.length} bytes, limit is ${MAX_BYTES}`, {
        publicMessage: 'That file is larger than the 25 MB limit.',
        field: 'content',
      });
    }
    // Verify the declared type against magic bytes. A caller claiming
    // application/pdf while sending something else would otherwise reach the
    // extraction model as an unexpected payload.
    assertMagicBytesMatch(bytes, input.contentType);

    const fingerprint = documentFingerprint(auth.tenantId, bytes);
    const invoiceId = newUuid() as InvoiceId;

    // Store the bytes BEFORE the transaction commits.
    //
    // Ordering matters and this is the safe direction. If the upload succeeds
    // and the commit then fails, we leak an orphan object — content-addressed,
    // so a retry reuses it, and a lifecycle rule sweeps the rest. The reverse
    // order would commit an invoice whose document does not exist, and the
    // extraction worker would fail on it forever.
    const stored = await deps.documents.put(auth.tenantId, fingerprint, bytes, input.contentType);
    const storageKey = stored.key;

    const result = await deps.db.withTenant(auth.tenantId, async (client) =>
      deps.db.transaction(client, async (tx) => {
        // The unique index does the deduplication. DO NOTHING + a follow-up
        // SELECT is race-free; a check-then-insert is not.
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO documents
             (tenant_id, fingerprint, storage_key, content_type, byte_size, source, source_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, fingerprint) DO NOTHING
           RETURNING id`,
          [
            auth.tenantId,
            fingerprint,
            storageKey,
            input.contentType,
            bytes.length,
            input.source,
            input.sourceRef ?? null,
          ],
        );

        if (inserted.rows.length === 0) {
          const existing = await tx.query<{ id: string; invoice_id: string | null }>(
            `SELECT d.id, i.id AS invoice_id
               FROM documents d
               LEFT JOIN invoices i ON i.document_id = d.id
              WHERE d.tenant_id = $1 AND d.fingerprint = $2`,
            [auth.tenantId, fingerprint],
          );
          return {
            duplicate: true,
            invoiceId: existing.rows[0]?.invoice_id ?? null,
            documentId: existing.rows[0]?.id ?? null,
          };
        }

        const documentId = inserted.rows[0]?.id;
        /* istanbul ignore next -- RETURNING guarantees a row here */
        if (!documentId) throw new ValidationError('Document insert returned no id');

        await tx.query(
          `INSERT INTO invoices (id, tenant_id, document_id, status) VALUES ($1,$2,$3,'received')`,
          [invoiceId, auth.tenantId, documentId],
        );

        // Enqueue via the outbox, not directly to Redis. If this transaction
        // rolls back, no orphan job exists; if it commits, the job is
        // guaranteed to be delivered.
        await enqueueOutbox(tx, auth.tenantId, {
          aggregateType: 'invoice',
          aggregateId: invoiceId,
          eventType: 'invoice.received',
          payload: { documentId, storageKey, contentType: input.contentType },
        });

        await tx.query(
          `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, context)
           VALUES ($1,'user',$2,'invoice.ingested','invoice',$3,$4::jsonb)`,
          [
            auth.tenantId,
            auth.userId,
            invoiceId,
            JSON.stringify({ source: input.source, bytes: bytes.length }),
          ],
        );

        return { duplicate: false, invoiceId, documentId };
      }),
    );

    invoicesIngested.inc({ source: input.source, deduplicated: String(result.duplicate) });

    // 200 for a duplicate, 201 for a new one. The client can tell the
    // difference without parsing the body, and neither is an error — a retry
    // succeeding idempotently is the correct outcome, not a failure.
    return reply.status(result.duplicate ? 200 : 201).send({
      invoiceId: result.invoiceId,
      documentId: result.documentId,
      duplicate: result.duplicate,
    });
  });
}

/**
 * Minimal container sniffing.
 *
 * Not a full validator — the extraction provider does its own parsing — but it
 * catches the common case of a mislabelled upload before we spend a model call
 * on it.
 */
function assertMagicBytesMatch(bytes: Buffer, declared: string): void {
  const startsWith = (sig: readonly number[]): boolean => sig.every((byte, i) => bytes[i] === byte);

  const matches =
    (declared === 'application/pdf' && startsWith([0x25, 0x50, 0x44, 0x46])) || // %PDF
    (declared === 'image/png' && startsWith([0x89, 0x50, 0x4e, 0x47])) ||
    (declared === 'image/jpeg' && startsWith([0xff, 0xd8, 0xff])) ||
    (declared === 'image/webp' && startsWith([0x52, 0x49, 0x46, 0x46])) ||
    (declared === 'image/tiff' &&
      (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a])));

  if (!matches) {
    throw new ValidationError(`Content does not match the declared type ${declared}`, {
      publicMessage: 'The uploaded file does not look like the type it claims to be.',
      field: 'content',
    });
  }
}
