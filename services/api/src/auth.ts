/**
 * Request authentication and tenant resolution.
 *
 * The tenant is taken from the verified token, NEVER from a header, query
 * parameter or body field the caller controls. That single rule is what makes
 * the RLS layer meaningful — an attacker who can choose `app.tenant_id` has
 * defeated the whole isolation model.
 */

import type { FastifyRequest } from 'fastify';
import {
  AuthError,
  PermissionError,
  asTenantId,
  asUserId,
  type TenantId,
  type UserId,
} from '@onelineflow/core';

export type Role = 'owner' | 'admin' | 'approver' | 'clerk' | 'viewer';

export interface AuthContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly role: Role;
  /** Approval ceiling in minor units; null means unlimited. */
  readonly approvalLimitMinor: bigint | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const ROLE_RANK: Readonly<Record<Role, number>> = {
  viewer: 0,
  clerk: 1,
  approver: 2,
  admin: 3,
  owner: 4,
};

/**
 * Resolve the caller.
 *
 * In this reference implementation the verified claims are expected to have been
 * attached by an upstream JWT plugin (`fastify-jwt` with `JWT_PUBLIC_KEY`). The
 * function is written so that the ONLY source of tenant identity is that
 * verified object.
 */
// Async by contract, not by current implementation: a future version will
// look up the member's live approval limit rather than trusting the token
// claim, and every call site already awaits.
// eslint-disable-next-line @typescript-eslint/require-await
export async function requireTenant(
  req: FastifyRequest,
  allowedRoles: readonly Role[] = [],
): Promise<AuthContext> {
  const auth = req.auth;
  if (!auth) {
    throw new AuthError('Request is not authenticated', {
      publicMessage: 'Sign in to continue.',
    });
  }

  if (allowedRoles.length > 0) {
    // Rank comparison rather than set membership, so specifying ['admin'] also
    // admits an owner. Listing every superior role at each call site is exactly
    // the kind of thing that gets forgotten on a new endpoint.
    const required = Math.min(...allowedRoles.map((r) => ROLE_RANK[r]));
    if (ROLE_RANK[auth.role] < required) {
      throw new PermissionError(
        `Role ${auth.role} is insufficient (need ${allowedRoles.join(' or ')})`,
        { publicMessage: 'You do not have permission to do that.' },
      );
    }
  }

  return auth;
}

/** Check an approver's ceiling against an invoice total. */
export function assertWithinApprovalLimit(auth: AuthContext, totalMinor: bigint): void {
  if (auth.approvalLimitMinor === null) return;
  if (totalMinor > auth.approvalLimitMinor) {
    throw new PermissionError(
      `Total ${totalMinor} exceeds the approval limit ${auth.approvalLimitMinor}`,
      {
        publicMessage: 'This invoice is above your approval limit and needs a higher approver.',
      },
    );
  }
}

/** Build an AuthContext from verified JWT claims. */
export function contextFromClaims(claims: Record<string, unknown>): AuthContext {
  const tenantId = claims['tenant_id'];
  const userId = claims['sub'];
  const role = claims['role'];

  if (typeof tenantId !== 'string' || typeof userId !== 'string' || typeof role !== 'string') {
    throw new AuthError('Token is missing required claims');
  }
  if (!(role in ROLE_RANK)) {
    throw new AuthError(`Unknown role in token: ${role}`);
  }

  const limit = claims['approval_limit_minor'];
  return {
    tenantId: asTenantId(tenantId),
    userId: asUserId(userId),
    role: role as Role,
    approvalLimitMinor:
      typeof limit === 'string' || typeof limit === 'number' ? BigInt(limit) : null,
  };
}
