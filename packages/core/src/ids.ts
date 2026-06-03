/**
 * Branded identifiers.
 *
 * At this scale nearly every function takes three or four opaque UUID strings.
 * Branding makes `postBill(tenantId, invoiceId)` a compile error when the
 * arguments are swapped — a class of bug that is otherwise invisible until it
 * leaks one tenant's data into another tenant's ledger.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, 'TenantId'>;
export type InvoiceId = Brand<string, 'InvoiceId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type ConnectionId = Brand<string, 'ConnectionId'>;
export type UserId = Brand<string, 'UserId'>;
export type OutboxId = Brand<string, 'OutboxId'>;
/** Intuit's company identifier. Opaque numeric string, not a UUID. */
export type RealmId = Brand<string, 'RealmId'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function makeUuidCaster<T>(label: string) {
  return (value: string): T => {
    if (!UUID_RE.test(value)) {
      throw new TypeError(`Invalid ${label}: expected a UUID, received "${value}"`);
    }
    return value as T;
  };
}

export const asTenantId = makeUuidCaster<TenantId>('TenantId');
export const asInvoiceId = makeUuidCaster<InvoiceId>('InvoiceId');
export const asDocumentId = makeUuidCaster<DocumentId>('DocumentId');
export const asConnectionId = makeUuidCaster<ConnectionId>('ConnectionId');
export const asUserId = makeUuidCaster<UserId>('UserId');
export const asOutboxId = makeUuidCaster<OutboxId>('OutboxId');

export function asRealmId(value: string): RealmId {
  const v = value.trim();
  if (!/^\d{1,32}$/.test(v)) {
    throw new TypeError(`Invalid RealmId: expected digits, received "${value}"`);
  }
  return v as RealmId;
}

export { randomUUID as newUuid } from 'node:crypto';
