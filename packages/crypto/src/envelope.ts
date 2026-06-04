/**
 * Envelope encryption for tenant OAuth tokens.
 *
 * Threat being addressed: a database dump, a leaked read replica, or a backup
 * on someone's laptop. Refresh tokens are the crown jewels here — one grants
 * indefinite read/write access to a company's general ledger.
 *
 * Design:
 *   - Each connection row gets its own random 256-bit DEK.
 *   - The DEK is wrapped by a versioned root key (KEK) held outside Postgres.
 *   - Ciphertext is AES-256-GCM with the tenant id and purpose bound in as AAD,
 *     so a row copied into another tenant's record fails to decrypt rather than
 *     silently working.
 *
 * A dump alone yields nothing; the attacker also needs the KEK from KMS.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigError, ValidationError } from '@onelineflow/core';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce: the GCM-recommended size.
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

export interface SealedBox {
  /** version(1) | ivLen(1) | iv | tagLen(1) | tag | ciphertext */
  readonly bytes: Buffer;
}

export interface Keyring {
  /** Wrap a DEK under the current root key. */
  wrapDek(dek: Buffer): Promise<{ wrapped: Buffer; keyVersion: number }>;
  /** Unwrap a DEK that was wrapped under `keyVersion`. */
  unwrapDek(wrapped: Buffer, keyVersion: number): Promise<Buffer>;
  /** Version new material should be wrapped under. */
  currentVersion(): number;
}

export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Additional Authenticated Data. Not secret, but cryptographically bound: any
 * mismatch between the AAD at seal time and open time fails the auth tag.
 */
export function aad(tenantId: string, purpose: string): Buffer {
  return Buffer.from(`onelineflow:v${FORMAT_VERSION}:${tenantId}:${purpose}`, 'utf8');
}

export function seal(plaintext: string, dek: Buffer, associatedData: Buffer): Buffer {
  assertKeyLength(dek);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    Buffer.from([iv.length]),
    iv,
    Buffer.from([tag.length]),
    tag,
    ct,
  ]);
}

export function open(sealed: Buffer, dek: Buffer, associatedData: Buffer): string {
  assertKeyLength(dek);
  if (sealed.length < 3 + IV_BYTES + TAG_BYTES) {
    throw new ValidationError('Sealed box is truncated');
  }

  let offset = 0;
  const version = sealed.readUInt8(offset);
  offset += 1;
  if (version !== FORMAT_VERSION) {
    throw new ValidationError(`Unsupported sealed-box format version ${version}`);
  }

  const ivLen = sealed.readUInt8(offset);
  offset += 1;
  const iv = sealed.subarray(offset, offset + ivLen);
  offset += ivLen;

  const tagLen = sealed.readUInt8(offset);
  offset += 1;
  const tag = sealed.subarray(offset, offset + tagLen);
  offset += tagLen;

  const ct = sealed.subarray(offset);

  const decipher = createDecipheriv(ALGORITHM, dek, iv, { authTagLength: tagLen });
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    // Deliberately opaque: never leak whether the tag, the key, or the AAD was
    // wrong — that distinction is an oracle.
    throw new ValidationError('Failed to decrypt sealed box', { cause: err });
  }
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new ConfigError(`Expected a ${KEY_BYTES}-byte key, received ${key.length}`);
  }
}

/**
 * Local keyring: root keys from the environment. Suitable for development and
 * for deployments where the operator injects keys from a secrets manager at
 * boot. Production should prefer a KMS-backed implementation of `Keyring` so the
 * root key never enters process memory in full — see docs/security.md.
 */
export class EnvKeyring implements Keyring {
  private readonly keys: ReadonlyMap<number, Buffer>;
  private readonly current: number;

  constructor(
    rootKeyB64: string,
    currentVersion: number,
    previous: ReadonlyMap<number, string> = new Map(),
  ) {
    const keys = new Map<number, Buffer>();
    const root = Buffer.from(rootKeyB64, 'base64');
    assertKeyLength(root);
    keys.set(currentVersion, root);

    // Older versions stay loaded so existing rows keep decrypting during a
    // rotation. Rows are re-wrapped lazily on next write.
    for (const [version, b64] of previous) {
      const k = Buffer.from(b64, 'base64');
      assertKeyLength(k);
      keys.set(version, k);
    }

    this.keys = keys;
    this.current = currentVersion;
  }

  currentVersion(): number {
    return this.current;
  }

  // Async to satisfy the Keyring contract: a KMS-backed implementation is
  // genuinely asynchronous, and callers must not depend on this one being
  // synchronous.
  // eslint-disable-next-line @typescript-eslint/require-await
  async wrapDek(dek: Buffer): Promise<{ wrapped: Buffer; keyVersion: number }> {
    const kek = this.keyFor(this.current);
    return {
      wrapped: seal(dek.toString('base64'), kek, Buffer.from('onelineflow:dek-wrap')),
      keyVersion: this.current,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async unwrapDek(wrapped: Buffer, keyVersion: number): Promise<Buffer> {
    const kek = this.keyFor(keyVersion);
    const dek = Buffer.from(open(wrapped, kek, Buffer.from('onelineflow:dek-wrap')), 'base64');
    assertKeyLength(dek);
    return dek;
  }

  private keyFor(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new ConfigError(
        `No root key loaded for version ${version}. Rotation must keep prior ` +
          'versions available until every row has been re-wrapped.',
      );
    }
    return key;
  }
}

/** Constant-time comparison for webhook signatures and similar. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
