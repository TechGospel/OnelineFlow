/**
 * Intuit OAuth connect flow.
 *
 * Security properties that matter here:
 *   - `state` is single-use, short-lived, and bound to the tenant. Without it an
 *     attacker can complete the callback and attach THEIR QuickBooks realm to a
 *     victim's tenant, or a victim's realm to their own — both are account
 *     takeover of the accounting integration.
 *   - The state token is stored in Redis, not in a cookie, so it cannot be
 *     replayed after use and expires on its own.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { asRealmId, asTenantId, PermissionError, ValidationError } from '@onelineflow/core';
import { buildAuthorizeUrl, exchangeAuthorizationCode } from '@onelineflow/qbo';
import type { AppInstance } from '../app-types.js';
import type { ApiDeps } from '../main.js';
import { requireTenant } from '../auth.js';

const STATE_TTL_SECONDS = 600;

const callbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  realmId: z.string().regex(/^\d+$/),
});

export function registerOAuthRoutes(app: AppInstance, deps: ApiDeps): void {
  const oauthConfig = {
    clientId: deps.cfg.QBO_CLIENT_ID,
    clientSecret: deps.cfg.QBO_CLIENT_SECRET,
    redirectUri: deps.cfg.QBO_REDIRECT_URI,
    timeoutMs: deps.cfg.QBO_REQUEST_TIMEOUT_MS,
  };

  /** Begin the connect flow. */
  app.post('/v1/qbo/connect', async (req, reply) => {
    const auth = await requireTenant(req, ['owner', 'admin']);

    const state = randomUUID();
    await deps.redis.setex(
      `${deps.cfg.QUEUE_PREFIX}:oauth:state:${state}`,
      STATE_TTL_SECONDS,
      JSON.stringify({ tenantId: auth.tenantId, userId: auth.userId }),
    );

    return reply.send({ authorizeUrl: buildAuthorizeUrl(oauthConfig, state) });
  });

  /** Intuit redirects the user's browser here. */
  app.get('/v1/qbo/callback', async (req, reply) => {
    const parsed = callbackQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Malformed OAuth callback', {
        publicMessage: 'The QuickBooks connection could not be completed. Please try again.',
      });
    }
    const { code, state, realmId } = parsed.data;

    // GETDEL: single-use by construction. A replayed callback finds nothing.
    const key = `${deps.cfg.QUEUE_PREFIX}:oauth:state:${state}`;
    const stored = await deps.redis.getdel(key);
    if (!stored) {
      throw new PermissionError('OAuth state is unknown or already used', {
        publicMessage: 'This connection link has expired. Start the connection again.',
      });
    }

    const { tenantId: rawTenantId, userId } = JSON.parse(stored) as {
      tenantId: string;
      userId: string;
    };
    // The GETDEL above IS the verification: an unknown or replayed state finds
    // no entry. There is nothing further to compare.
    const tenantId = asTenantId(rawTenantId);
    const tokens = await exchangeAuthorizationCode(oauthConfig, code);

    await deps.db.withTenant(tenantId, async (client) => {
      const connectionId = await deps.connections.upsert(client, {
        tenantId,
        realmId: asRealmId(realmId),
        environment: deps.cfg.QBO_ENVIRONMENT,
        tokens,
      });

      await client.query(
        `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, context)
         VALUES ($1, 'user', $2, 'qbo.connected', 'connection', $3, $4::jsonb)`,
        [tenantId, userId, connectionId, JSON.stringify({ realmId })],
      );
    });

    deps.logger.info({ tenantId, realmId }, 'QuickBooks connected');
    return reply.redirect(`/settings/integrations?connected=1&realm=${realmId}`);
  });

  /** Disconnect. Revoking with Intuit is best-effort; local state is authoritative. */
  app.post('/v1/qbo/disconnect', async (req, reply) => {
    const auth = await requireTenant(req, ['owner', 'admin']);

    await deps.db.withTenant(auth.tenantId, async (client) => {
      await client.query(
        `UPDATE qbo_connections SET status = 'revoked' WHERE tenant_id = $1 AND status = 'active'`,
        [auth.tenantId],
      );
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id)
         VALUES ($1, 'user', $2, 'qbo.disconnected', 'connection', 'all')`,
        [auth.tenantId, auth.userId],
      );
    });

    return reply.send({ ok: true });
  });
}
