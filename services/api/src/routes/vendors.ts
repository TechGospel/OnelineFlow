/**
 * Vendor resolution and creation.
 *
 * Auto-creating a vendor on a typo'd name permanently pollutes a tenant's chart
 * of accounts, and QuickBooks makes vendors hard to merge after the fact. So
 * creation stays an explicit, reviewed action — but "explicit" must not mean
 * "painful", or clerks will work around it.
 *
 * The flow this supports:
 *
 *   1. An invoice blocks on VENDOR_NOT_FOUND.
 *   2. The reviewer sees near-matches ranked by similarity.
 *   3. They either LINK to an existing vendor — the common case, a naming
 *      variant — or CREATE a new one, having seen that no match exists.
 *
 * Presenting the candidates first is what makes the default action the correct
 * one. A bare "Create vendor" button with no context guarantees duplicates.
 */

import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError, asRealmId } from '@onelineflow/core';
import { escapeQboLiteral, normaliseLookupKey } from '@onelineflow/qbo';
import type { AppInstance } from '../app-types.js';
import type { ApiDeps } from '../main.js';
import { requireTenant } from '../auth.js';

const suggestQuery = z.object({
  name: z.string().min(1).max(500),
  realmId: z.string().regex(/^\d+$/),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

const linkBody = z.object({
  realmId: z.string().regex(/^\d+$/),
  /** The name as it appeared on the invoice. */
  extractedName: z.string().min(1).max(500),
  /** The QuickBooks vendor to bind it to. */
  qboVendorId: z.string().min(1).max(64),
});

const createBody = z.object({
  realmId: z.string().regex(/^\d+$/),
  displayName: z.string().min(1).max(100),
  extractedName: z.string().min(1).max(500).optional(),
  email: z.string().email().max(200).optional(),
  /**
   * Required, and free text on purpose. The reviewer has to state that they
   * checked the suggestions — a checkbox would be clicked without reading.
   */
  confirmedNoMatch: z.literal(true),
});

export function registerVendorRoutes(app: AppInstance, deps: ApiDeps): void {
  /* ------------------------------------------------------------------ */
  /* Suggest near-matches                                                */
  /* ------------------------------------------------------------------ */
  app.get('/v1/vendors/suggest', async (req, reply) => {
    const auth = await requireTenant(req, ['clerk']);
    const parsed = suggestQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '), {
        publicMessage: 'Invalid vendor search.',
      });
    }
    const { name, realmId, limit } = parsed.data;

    const suggestions = await deps.db.withTenant(auth.tenantId, async (client) => {
      // Trigram similarity over the reference cache. Cheap, and it reflects the
      // vendors this tenant actually uses rather than their whole QBO list.
      const { rows } = await client.query<{
        qbo_id: string;
        display_name: string;
        similarity: number;
      }>(
        `SELECT qbo_id, display_name, similarity(display_name, $3) AS similarity
           FROM qbo_reference_cache
          WHERE tenant_id = $1 AND realm_id = $2 AND entity_type = 'Vendor'
            AND similarity(display_name, $3) > 0.25
          ORDER BY similarity DESC
          LIMIT $4`,
        [auth.tenantId, realmId, name, limit],
      );
      return rows;
    });

    return reply.send({
      query: name,
      suggestions: suggestions.map((s) => ({
        qboVendorId: s.qbo_id,
        displayName: s.display_name,
        similarity: Number(s.similarity),
        // A strong match is worth defaulting the UI to; a weak one is not.
        confidence: s.similarity > 0.6 ? 'high' : s.similarity > 0.4 ? 'medium' : 'low',
      })),
      // Absence of suggestions is itself information the reviewer needs before
      // being offered a Create button.
      exhausted: suggestions.length < limit,
    });
  });

  /* ------------------------------------------------------------------ */
  /* Link an extracted name to an existing QuickBooks vendor             */
  /* ------------------------------------------------------------------ */
  app.post('/v1/vendors/link', async (req, reply) => {
    const auth = await requireTenant(req, ['approver']);
    const parsed = linkBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '), {
        publicMessage: 'Invalid link request.',
      });
    }
    const { realmId, extractedName, qboVendorId } = parsed.data;
    const lookupKey = normaliseLookupKey(extractedName);

    if (!lookupKey) {
      throw new ValidationError('Extracted name normalises to nothing', {
        publicMessage: 'That vendor name cannot be linked.',
        field: 'extractedName',
      });
    }

    const result = await deps.db.withTenant(auth.tenantId, async (client) => {
      const connection = await deps.connections.findActive(
        client,
        auth.tenantId,
        asRealmId(realmId),
      );

      // Verify the vendor exists in QuickBooks before caching it. Caching an id
      // that does not exist turns one blocked invoice into every future invoice
      // from that vendor failing at post time instead of at review time.
      const rows = await deps.qbo.query<{ Id: string; DisplayName: string; Active?: boolean }>(
        client,
        { tenantId: auth.tenantId, realmId: asRealmId(realmId) },
        connection,
        `select Id, DisplayName, Active from Vendor where Id = '${escapeQboLiteral(qboVendorId)}'`,
      );

      const vendor = rows[0];
      if (!vendor) {
        throw new NotFoundError(`Vendor ${qboVendorId} does not exist in QuickBooks`, {
          publicMessage: 'That vendor no longer exists in QuickBooks.',
        });
      }
      if (vendor.Active === false) {
        throw new ConflictError(`Vendor ${qboVendorId} is inactive in QuickBooks`, {
          publicMessage: `"${vendor.DisplayName}" is inactive in QuickBooks. Reactivate it first.`,
        });
      }

      await client.query(
        `INSERT INTO qbo_reference_cache
           (tenant_id, realm_id, entity_type, lookup_key, qbo_id, display_name, payload, refreshed_at)
         VALUES ($1,$2,'Vendor',$3,$4,$5,$6::jsonb, now())
         ON CONFLICT (tenant_id, realm_id, entity_type, lookup_key) DO UPDATE SET
           qbo_id = EXCLUDED.qbo_id,
           display_name = EXCLUDED.display_name,
           refreshed_at = now()`,
        [auth.tenantId, realmId, lookupKey, vendor.Id, vendor.DisplayName, JSON.stringify(vendor)],
      );

      await client.query(
        `INSERT INTO audit_log
           (tenant_id, actor_type, actor_id, action, entity_type, entity_id, context)
         VALUES ($1,'user',$2,'vendor.linked','vendor',$3,$4::jsonb)`,
        [
          auth.tenantId,
          auth.userId,
          vendor.Id,
          JSON.stringify({ extractedName, lookupKey, displayName: vendor.DisplayName }),
        ],
      );

      return { qboVendorId: vendor.Id, displayName: vendor.DisplayName };
    });

    const unblocked = await requeueBlockedInvoices(deps, auth.tenantId, extractedName);
    return reply.send({ ...result, linkedName: extractedName, invoicesUnblocked: unblocked });
  });

  /* ------------------------------------------------------------------ */
  /* Create a vendor in QuickBooks                                       */
  /* ------------------------------------------------------------------ */
  app.post('/v1/vendors', async (req, reply) => {
    // Approver, not clerk. Creating a vendor writes to the tenant's chart of
    // accounts, which is a heavier action than processing an invoice.
    const auth = await requireTenant(req, ['approver']);

    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '), {
        publicMessage: 'To create a vendor you must confirm no existing vendor matches.',
        field: 'confirmedNoMatch',
      });
    }
    const { realmId, displayName, extractedName, email } = parsed.data;

    const created = await deps.db.withTenant(auth.tenantId, async (client) => {
      const connection = await deps.connections.findActive(
        client,
        auth.tenantId,
        asRealmId(realmId),
      );

      // Re-check for an exact match server-side. The client saw suggestions at
      // some earlier moment; another reviewer may have created it since.
      const existing = await deps.qbo.query<{ Id: string; DisplayName: string }>(
        client,
        { tenantId: auth.tenantId, realmId: asRealmId(realmId) },
        connection,
        `select Id, DisplayName from Vendor where DisplayName = '${escapeQboLiteral(displayName)}'`,
      );
      if (existing[0]) {
        throw new ConflictError(`Vendor "${displayName}" already exists in QuickBooks`, {
          publicMessage: `"${displayName}" already exists. Link to it instead of creating a duplicate.`,
          context: { qboVendorId: existing[0].Id },
        });
      }

      const response = await deps.qbo.request<{ Vendor: { Id: string; DisplayName: string } }>(
        client,
        { tenantId: auth.tenantId, realmId: asRealmId(realmId) },
        connection,
        {
          method: 'POST',
          path: '/vendor',
          body: {
            DisplayName: displayName,
            ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
          },
          // Deterministic per name so a double-submit cannot create two.
          requestId: `of-v-${normaliseLookupKey(displayName).slice(0, 40)}`,
        },
      );

      const vendor = response.Vendor;
      if (!vendor?.Id) {
        throw new ValidationError('QuickBooks returned no vendor id');
      }

      // Cache under BOTH the created name and the extracted name, so the
      // invoice that triggered this resolves without a second round trip.
      const keys = new Set([normaliseLookupKey(displayName)]);
      if (extractedName) keys.add(normaliseLookupKey(extractedName));

      for (const key of keys) {
        if (!key) continue;
        await client.query(
          `INSERT INTO qbo_reference_cache
             (tenant_id, realm_id, entity_type, lookup_key, qbo_id, display_name, refreshed_at)
           VALUES ($1,$2,'Vendor',$3,$4,$5, now())
           ON CONFLICT (tenant_id, realm_id, entity_type, lookup_key) DO UPDATE SET
             qbo_id = EXCLUDED.qbo_id, display_name = EXCLUDED.display_name, refreshed_at = now()`,
          [auth.tenantId, realmId, key, vendor.Id, vendor.DisplayName],
        );
      }

      await client.query(
        `INSERT INTO audit_log
           (tenant_id, actor_type, actor_id, action, entity_type, entity_id, context)
         VALUES ($1,'user',$2,'vendor.created','vendor',$3,$4::jsonb)`,
        [
          auth.tenantId,
          auth.userId,
          vendor.Id,
          JSON.stringify({
            displayName,
            extractedName: extractedName ?? null,
            email: email ?? null,
          }),
        ],
      );

      return { qboVendorId: vendor.Id, displayName: vendor.DisplayName };
    });

    const unblocked = extractedName
      ? await requeueBlockedInvoices(deps, auth.tenantId, extractedName)
      : 0;

    return reply.status(201).send({ ...created, invoicesUnblocked: unblocked });
  });
}

/**
 * Move invoices blocked on this vendor name back into the approval queue.
 *
 * Without this the reviewer resolves the vendor and the invoices stay stuck,
 * which reads as the fix not having worked. Matching on `vendor_name` is exact
 * because that is the value the resolver will look up next time.
 */
async function requeueBlockedInvoices(
  deps: ApiDeps,
  tenantId: Parameters<ApiDeps['db']['withTenant']>[0],
  vendorName: string,
): Promise<number> {
  return deps.db.withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE invoices
          SET status = 'pending_approval',
              version = version + 1,
              failure_code = NULL,
              failure_message = NULL,
              findings = coalesce(
                (SELECT jsonb_agg(f)
                   FROM jsonb_array_elements(findings) f
                  WHERE f->>'code' NOT IN ('VENDOR_NOT_FOUND', 'VENDOR_AMBIGUOUS')),
                '[]'::jsonb),
              updated_at = now()
        WHERE vendor_name = $1
          AND status IN ('needs_review', 'failed')
          AND findings @> '[{"code":"VENDOR_NOT_FOUND"}]'::jsonb`,
      [vendorName],
    );
    return rowCount ?? 0;
  });
}
