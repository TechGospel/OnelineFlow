/**
 * Intuit webhooks.
 *
 * Intuit signs each payload with HMAC-SHA256 over the RAW body using the
 * verifier token. Two traps:
 *
 *   1. The signature must be computed over the exact bytes received. If Fastify
 *      has already parsed and re-serialised the JSON, key order and whitespace
 *      change and every signature fails. Hence the raw-body content type parser.
 *   2. Comparison must be constant-time. A byte-by-byte early-exit compare leaks
 *      the expected signature to a patient attacker.
 *
 * Webhooks are also the cache-invalidation channel: when a vendor is renamed in
 * QuickBooks, our reference cache would otherwise serve a stale id for 24 hours.
 */

import { createHmac } from 'node:crypto';
import { asRealmId, PermissionError } from '@onelineflow/core';
import { safeEqual } from '@onelineflow/crypto';
import type { AppInstance } from '../app-types.js';
import type { ApiDeps } from '../main.js';

interface IntuitEventNotification {
  realmId: string;
  dataChangeEvent?: {
    entities?: Array<{
      name: string;
      id: string;
      operation: 'Create' | 'Update' | 'Delete' | 'Merge' | 'Void';
      lastUpdated: string;
    }>;
  };
}

const CACHEABLE_ENTITIES = new Set([
  'Vendor',
  'Customer',
  'Account',
  'Item',
  'TaxCode',
  'Term',
  'Class',
]);

export function registerWebhookRoutes(app: AppInstance, deps: ApiDeps): void {
  const verifier = deps.cfg.QBO_WEBHOOK_VERIFIER_TOKEN;

  // Capture the raw body: signature verification requires the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    if (req.url.startsWith('/v1/webhooks/intuit')) {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    }
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post('/v1/webhooks/intuit', async (req, reply) => {
    if (!verifier) {
      // Configured absent in dev. Refuse rather than accept unsigned events —
      // an unauthenticated webhook endpoint is a cache-poisoning primitive.
      throw new PermissionError('Webhook verification is not configured');
    }

    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.headers['intuit-signature'];
    if (!raw || typeof signature !== 'string') {
      throw new PermissionError('Missing webhook signature');
    }

    const expected = createHmac('sha256', verifier).update(raw).digest('base64');
    if (!safeEqual(expected, signature)) {
      deps.logger.warn({ ip: req.ip }, 'rejected webhook with an invalid signature');
      throw new PermissionError('Invalid webhook signature');
    }

    // Acknowledge immediately. Intuit retries on a slow or failed response, and
    // doing real work here would turn a burst of events into a queue of open
    // HTTP connections. Process asynchronously.
    const body = req.body as { eventNotifications?: IntuitEventNotification[] };
    setImmediate(() => {
      void handleNotifications(deps, body.eventNotifications ?? []).catch((err: unknown) =>
        deps.logger.error({ err }, 'webhook processing failed'),
      );
    });

    return reply.status(200).send();
  });
}

async function handleNotifications(
  deps: ApiDeps,
  notifications: readonly IntuitEventNotification[],
): Promise<void> {
  for (const notification of notifications) {
    const realmId = asRealmId(notification.realmId);

    // Map realm -> tenant. A realm we do not know about is not an error: Intuit
    // may still be sending events for a disconnected company.
    const tenantId = await deps.db.withBypass('resolve realm from webhook', async (client) => {
      const { rows } = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM qbo_connections WHERE realm_id = $1 AND status = 'active' LIMIT 1`,
        [realmId],
      );
      return rows[0]?.tenant_id ?? null;
    });

    if (!tenantId) {
      deps.logger.debug({ realmId }, 'webhook for an unknown or disconnected realm; ignoring');
      continue;
    }

    const entities = notification.dataChangeEvent?.entities ?? [];
    await deps.db.withTenant(tenantId as never, async (client) => {
      for (const entity of entities) {
        if (CACHEABLE_ENTITIES.has(entity.name)) {
          await client.query(
            `DELETE FROM qbo_reference_cache
              WHERE tenant_id = $1 AND realm_id = $2 AND entity_type = $3 AND qbo_id = $4`,
            [tenantId, realmId, entity.name, entity.id],
          );
        }

        // A bill deleted or voided in QuickBooks means our record is stale. Flag
        // it rather than auto-reverting: the tenant deleted it deliberately and
        // we should not silently recreate or discard our copy.
        if (
          entity.name === 'Bill' &&
          (entity.operation === 'Delete' || entity.operation === 'Void')
        ) {
          await client.query(
            `UPDATE invoices
                SET findings = findings || $1::jsonb, updated_at = now()
              WHERE tenant_id = $2 AND qbo_realm_id = $3 AND qbo_entity_id = $4
                AND status = 'posted'`,
            [
              JSON.stringify([
                {
                  code: 'QBO_BILL_REMOVED',
                  severity: 'blocking',
                  message: `The bill was ${entity.operation.toLowerCase()}d in QuickBooks on ${entity.lastUpdated}.`,
                },
              ]),
              tenantId,
              realmId,
              entity.id,
            ],
          );
        }
      }
    });
  }
}
