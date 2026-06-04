import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { aad, EnvKeyring, generateDek, open, safeEqual, seal } from './envelope.js';
import { ConfigError, ValidationError } from '@onelineflow/core';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('seal/open', () => {
  it('round-trips a token', () => {
    const dek = generateDek();
    const ad = aad(TENANT_A, 'qbo-token');
    const secret = 'refresh-token-value';
    expect(open(seal(secret, dek, ad), dek, ad)).toBe(secret);
  });

  it('produces different ciphertext each time (random nonce)', () => {
    const dek = generateDek();
    const ad = aad(TENANT_A, 'qbo-token');
    const a = seal('same', dek, ad);
    const b = seal('same', dek, ad);
    expect(a.equals(b)).toBe(false);
  });

  it('fails when the DEK is wrong', () => {
    const ad = aad(TENANT_A, 'qbo-token');
    const sealed = seal('secret', generateDek(), ad);
    expect(() => open(sealed, generateDek(), ad)).toThrow(ValidationError);
  });

  it('fails when the row is moved to another tenant', () => {
    // AAD binding: a ciphertext copied into another tenant's record must not
    // decrypt, so a row-level mix-up fails loudly instead of leaking silently.
    const dek = generateDek();
    const sealed = seal('secret', dek, aad(TENANT_A, 'qbo-token'));
    expect(() => open(sealed, dek, aad(TENANT_B, 'qbo-token'))).toThrow(ValidationError);
  });

  it('fails when the purpose differs', () => {
    const dek = generateDek();
    const sealed = seal('secret', dek, aad(TENANT_A, 'qbo-token'));
    expect(() => open(sealed, dek, aad(TENANT_A, 'other-purpose'))).toThrow(ValidationError);
  });

  it('detects tampering with the ciphertext', () => {
    const dek = generateDek();
    const ad = aad(TENANT_A, 'qbo-token');
    const sealed = seal('secret', dek, ad);
    // readUInt8/writeUInt8 rather than index assignment: under
    // noUncheckedIndexedAccess a Buffer index reads as `number | undefined`.
    const last = sealed.length - 1;
    sealed.writeUInt8(sealed.readUInt8(last) ^ 0xff, last);
    expect(() => open(sealed, dek, ad)).toThrow(ValidationError);
  });

  it('gives the same opaque error whatever went wrong', () => {
    // Distinguishing "bad tag" from "bad key" from "bad AAD" is an oracle.
    const dek = generateDek();
    const ad = aad(TENANT_A, 'qbo-token');
    const sealed = seal('secret', dek, ad);
    const wrongKey = (() => {
      try {
        open(sealed, generateDek(), ad);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    const wrongAad = (() => {
      try {
        open(sealed, dek, aad(TENANT_B, 'qbo-token'));
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(wrongKey).toBe(wrongAad);
  });

  it('rejects a truncated box', () => {
    expect(() => open(Buffer.alloc(4), generateDek(), aad(TENANT_A, 'x'))).toThrow(ValidationError);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => seal('x', Buffer.alloc(16), aad(TENANT_A, 'x'))).toThrow(ConfigError);
  });
});

describe('EnvKeyring', () => {
  const rootV1 = randomBytes(32).toString('base64');
  const rootV2 = randomBytes(32).toString('base64');

  it('wraps and unwraps a DEK', async () => {
    const keyring = new EnvKeyring(rootV1, 1);
    const dek = generateDek();
    const { wrapped, keyVersion } = await keyring.wrapDek(dek);
    expect(keyVersion).toBe(1);
    expect((await keyring.unwrapDek(wrapped, 1)).equals(dek)).toBe(true);
  });

  it('still decrypts old rows during a rotation', async () => {
    // Rows wrapped under v1 must keep opening after the current version moves
    // to v2, or a rotation is an outage.
    const v1Only = new EnvKeyring(rootV1, 1);
    const dek = generateDek();
    const { wrapped } = await v1Only.wrapDek(dek);

    const rotated = new EnvKeyring(rootV2, 2, new Map([[1, rootV1]]));
    expect(rotated.currentVersion()).toBe(2);
    expect((await rotated.unwrapDek(wrapped, 1)).equals(dek)).toBe(true);
  });

  it('fails loudly when a needed prior version was dropped', async () => {
    const v1 = new EnvKeyring(rootV1, 1);
    const { wrapped } = await v1.wrapDek(generateDek());
    const v2Only = new EnvKeyring(rootV2, 2);
    await expect(v2Only.unwrapDek(wrapped, 1)).rejects.toThrow(ConfigError);
  });

  it('rejects a root key of the wrong size', () => {
    expect(() => new EnvKeyring(randomBytes(16).toString('base64'), 1)).toThrow(ConfigError);
  });
});

describe('safeEqual', () => {
  it('matches identical values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('rejects different values', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
