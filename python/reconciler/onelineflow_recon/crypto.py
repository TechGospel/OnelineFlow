"""Envelope decryption, compatible with ``packages/crypto`` in the Node core.

The reconciler needs a tenant's QuickBooks access token, which is stored sealed.
That means this module must reproduce the Node sealing format EXACTLY — a
mismatch here is not a subtle bug, it is "the nightly job cannot read any
tenant's token" at 2am.

Wire format (from ``packages/crypto/src/envelope.ts``)::

    version(1) | ivLen(1) | iv | tagLen(1) | tag | ciphertext

* AES-256-GCM.
* AAD for a token is ``onelineflow:v1:<tenant_id>:<purpose>``.
* AAD for the DEK wrap is the fixed string ``onelineflow:dek-wrap``.
* A wrapped DEK decrypts to the *base64* text of the 32-byte key, not the raw
  bytes — matching how the Node side seals it.

Deliberately decrypt-only. The reconciler has no business minting new sealed
values, and a write path here would be a second implementation of key handling
to keep in sync.

``tests/test_crypto_interop.py`` verifies against fixtures produced by the real
Node implementation, so drift is caught in CI rather than in production.
"""

from __future__ import annotations

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

FORMAT_VERSION = 1
KEY_BYTES = 32
DEK_WRAP_AAD = b"onelineflow:dek-wrap"


class DecryptionError(Exception):
    """Raised for every decryption failure, without distinguishing the cause.

    Reporting whether the key, the tag or the AAD was wrong would be an oracle.
    The Node side is deliberately opaque in the same way.
    """


def token_aad(tenant_id: str, purpose: str) -> bytes:
    """Build the additional authenticated data for a sealed token.

    Must match ``aad()`` in envelope.ts character for character. The tenant id is
    bound in, so a ciphertext copied into another tenant's row fails to decrypt
    rather than silently working.
    """
    return f"onelineflow:v{FORMAT_VERSION}:{tenant_id}:{purpose}".encode()


def open_sealed(sealed: bytes, dek: bytes, aad: bytes) -> str:
    """Open a sealed box and return the plaintext as UTF-8."""
    if len(dek) != KEY_BYTES:
        raise DecryptionError(f"Expected a {KEY_BYTES}-byte key, got {len(dek)}")

    # 3 length bytes + a 12-byte nonce + a 16-byte tag is the structural minimum.
    if len(sealed) < 3 + 12 + 16:
        raise DecryptionError("Sealed box is truncated")

    offset = 0
    version = sealed[offset]
    offset += 1
    if version != FORMAT_VERSION:
        raise DecryptionError(f"Unsupported sealed-box format version {version}")

    iv_len = sealed[offset]
    offset += 1
    iv = sealed[offset : offset + iv_len]
    offset += iv_len

    tag_len = sealed[offset]
    offset += 1
    tag = sealed[offset : offset + tag_len]
    offset += tag_len

    ciphertext = sealed[offset:]

    if len(iv) != iv_len or len(tag) != tag_len:
        raise DecryptionError("Sealed box header does not match its length")

    # Python's AESGCM expects the tag appended to the ciphertext; Node keeps
    # them separate. Recombining here is the whole interop wrinkle.
    try:
        plaintext = AESGCM(dek).decrypt(iv, ciphertext + tag, aad)
    except InvalidTag as exc:
        raise DecryptionError("Failed to decrypt sealed box") from exc
    except Exception as exc:  # noqa: BLE001 - normalise every failure
        raise DecryptionError("Failed to decrypt sealed box") from exc

    return plaintext.decode("utf-8")


def unwrap_dek(wrapped: bytes, root_key: bytes) -> bytes:
    """Unwrap a data encryption key using the versioned root key.

    The Node side seals the DEK's *base64 text*, so this decodes that text back
    to raw bytes rather than treating the plaintext as the key directly.
    """
    import base64

    material = open_sealed(wrapped, root_key, DEK_WRAP_AAD)
    dek = base64.b64decode(material)
    if len(dek) != KEY_BYTES:
        raise DecryptionError(f"Unwrapped DEK is {len(dek)} bytes, expected {KEY_BYTES}")
    return dek


class Keyring:
    """Root keys by version.

    Prior versions must stay loaded during a rotation: rows are re-wrapped lazily
    on next write, so the reconciler still meets old ones for a long time. A
    keyring that drops old versions turns a rotation into a nightly-job outage.
    """

    def __init__(self, keys: dict[int, bytes]) -> None:
        for version, key in keys.items():
            if len(key) != KEY_BYTES:
                raise DecryptionError(
                    f"Root key v{version} is {len(key)} bytes, expected {KEY_BYTES}"
                )
        self._keys = dict(keys)

    @classmethod
    def from_env(cls, root_key_b64: str, version: int, previous: dict[int, str] | None = None) -> Keyring:
        import base64

        keys = {version: base64.b64decode(root_key_b64)}
        for prev_version, prev_b64 in (previous or {}).items():
            keys[prev_version] = base64.b64decode(prev_b64)
        return cls(keys)

    def unwrap(self, wrapped: bytes, key_version: int) -> bytes:
        key = self._keys.get(key_version)
        if key is None:
            raise DecryptionError(
                f"No root key loaded for version {key_version}. Keep prior versions "
                "available until every row has been re-wrapped."
            )
        return unwrap_dek(wrapped, key)

    def open_token(
        self,
        sealed: bytes,
        wrapped_dek: bytes,
        key_version: int,
        tenant_id: str,
        purpose: str = "qbo-token",
    ) -> str:
        """Unwrap the DEK and open a sealed token in one step."""
        dek = self.unwrap(wrapped_dek, key_version)
        try:
            return open_sealed(sealed, dek, token_aad(tenant_id, purpose))
        finally:
            # Best effort: Python bytes are immutable, so the object cannot be
            # zeroed in place. Dropping the only reference at least shortens the
            # window before the allocator reuses the memory.
            del dek
