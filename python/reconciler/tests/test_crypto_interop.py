"""Cross-language crypto interop.

Every fixture here was produced by the REAL Node implementation
(``scripts/gen-crypto-fixtures.ts``). A Python-only test would prove Python
agrees with itself, which is worth nothing: the failure this guards against is
the two implementations drifting apart, and its production symptom is "the
reconciler cannot read any tenant's token".
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from onelineflow_recon.crypto import (
    DecryptionError,
    Keyring,
    open_sealed,
    token_aad,
    unwrap_dek,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "crypto_interop.json").read_text()
)


def b64(name: str) -> bytes:
    return base64.b64decode(FIXTURES[name])


@pytest.fixture
def dek() -> bytes:
    return unwrap_dek(b64("wrappedDekB64"), b64("rootKeyB64"))


class TestDekUnwrap:
    def test_unwraps_a_node_sealed_dek(self, dek: bytes) -> None:
        assert len(dek) == 32

    def test_rejects_the_wrong_root_key(self) -> None:
        with pytest.raises(DecryptionError):
            unwrap_dek(b64("wrappedDekB64"), bytes(32))


class TestTokenDecryption:
    def test_opens_a_node_sealed_access_token(self, dek: bytes) -> None:
        plaintext = open_sealed(
            b64("accessTokenSealedB64"), dek, token_aad(FIXTURES["tenantA"], "qbo-token")
        )
        assert plaintext == FIXTURES["accessTokenPlain"]

    def test_opens_a_node_sealed_refresh_token(self, dek: bytes) -> None:
        plaintext = open_sealed(
            b64("refreshTokenSealedB64"), dek, token_aad(FIXTURES["tenantA"], "qbo-token")
        )
        assert plaintext == FIXTURES["refreshTokenPlain"]

    def test_round_trips_non_ascii_exactly(self, dek: bytes) -> None:
        # UTF-8 handling is a classic place for two languages to diverge.
        plaintext = open_sealed(
            b64("unicodeSealedB64"), dek, token_aad(FIXTURES["tenantA"], "qbo-token")
        )
        assert plaintext == FIXTURES["unicodePlain"]


class TestAadBinding:
    """The AAD binding is what stops a row copied between tenants from working."""

    def test_refuses_a_ciphertext_sealed_for_another_tenant(self, dek: bytes) -> None:
        with pytest.raises(DecryptionError):
            open_sealed(
                b64("wrongTenantSealedB64"),
                dek,
                token_aad(FIXTURES["tenantA"], "qbo-token"),
            )

    def test_refuses_a_ciphertext_sealed_for_another_purpose(self, dek: bytes) -> None:
        with pytest.raises(DecryptionError):
            open_sealed(
                b64("wrongPurposeSealedB64"),
                dek,
                token_aad(FIXTURES["tenantA"], "qbo-token"),
            )

    def test_aad_string_matches_the_node_format_exactly(self) -> None:
        # Byte-for-byte. Any drift here silently breaks every token.
        assert token_aad("abc", "qbo-token") == b"onelineflow:v1:abc:qbo-token"


class TestTampering:
    def test_detects_a_flipped_ciphertext_byte(self, dek: bytes) -> None:
        sealed = bytearray(b64("accessTokenSealedB64"))
        sealed[-1] ^= 0xFF
        with pytest.raises(DecryptionError):
            open_sealed(bytes(sealed), dek, token_aad(FIXTURES["tenantA"], "qbo-token"))

    def test_detects_a_flipped_tag_byte(self, dek: bytes) -> None:
        sealed = bytearray(b64("accessTokenSealedB64"))
        sealed[5] ^= 0xFF  # inside the auth tag
        with pytest.raises(DecryptionError):
            open_sealed(bytes(sealed), dek, token_aad(FIXTURES["tenantA"], "qbo-token"))

    def test_rejects_a_truncated_box(self, dek: bytes) -> None:
        with pytest.raises(DecryptionError):
            open_sealed(b"\x01\x0c", dek, token_aad(FIXTURES["tenantA"], "qbo-token"))

    def test_rejects_an_unknown_format_version(self, dek: bytes) -> None:
        sealed = bytearray(b64("accessTokenSealedB64"))
        sealed[0] = 99
        with pytest.raises(DecryptionError, match="version"):
            open_sealed(bytes(sealed), dek, token_aad(FIXTURES["tenantA"], "qbo-token"))

    def test_failure_message_is_uniform(self, dek: bytes) -> None:
        # Distinguishing "bad key" from "bad AAD" is an oracle. The Node side is
        # deliberately opaque and this must match.
        messages = set()
        for name in ("wrongTenantSealedB64", "wrongPurposeSealedB64"):
            try:
                open_sealed(b64(name), dek, token_aad(FIXTURES["tenantA"], "qbo-token"))
            except DecryptionError as exc:
                messages.add(str(exc))
        assert len(messages) == 1


class TestKeyring:
    def test_opens_a_token_end_to_end(self) -> None:
        keyring = Keyring.from_env(FIXTURES["rootKeyB64"], FIXTURES["keyVersion"])
        assert (
            keyring.open_token(
                b64("accessTokenSealedB64"),
                b64("wrappedDekB64"),
                FIXTURES["keyVersion"],
                FIXTURES["tenantA"],
            )
            == FIXTURES["accessTokenPlain"]
        )

    def test_keeps_prior_versions_readable_during_rotation(self) -> None:
        # A rotation that cannot decrypt yesterday's rows is an outage.
        new_root = base64.b64encode(bytes(range(32))).decode()
        keyring = Keyring.from_env(new_root, 2, {1: FIXTURES["rootKeyB64"]})
        assert (
            keyring.open_token(
                b64("accessTokenSealedB64"),
                b64("wrappedDekB64"),
                1,
                FIXTURES["tenantA"],
            )
            == FIXTURES["accessTokenPlain"]
        )

    def test_reports_a_missing_key_version_clearly(self) -> None:
        keyring = Keyring.from_env(FIXTURES["rootKeyB64"], 1)
        with pytest.raises(DecryptionError, match="No root key loaded for version 9"):
            keyring.open_token(
                b64("accessTokenSealedB64"), b64("wrappedDekB64"), 9, FIXTURES["tenantA"]
            )

    def test_rejects_a_root_key_of_the_wrong_size(self) -> None:
        with pytest.raises(DecryptionError):
            Keyring.from_env(base64.b64encode(bytes(16)).decode(), 1)
