"""Orchestrates a reconciliation run.

Per tenant-realm: fetch the QuickBooks window, index it, compare against our
posted invoices, and record the breaks.

Two decisions worth stating:

* **One tenant's failure does not fail the run.** A revoked grant or a
  throttled realm produces a break for that tenant and the run continues. A
  reconciler that aborts on the first bad tenant reconciles nobody.
* **A suspected "missing" bill is re-checked by id** before being reported.
  The bulk query is windowed by ``TxnDate``; a bill whose date was edited in
  QuickBooks falls outside the window and would otherwise be reported missing
  every single night. Nothing erodes trust in a report faster than a permanent
  false positive.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row

from onelineflow_recon.crypto import DecryptionError, Keyring
from onelineflow_recon.models import Break, BreakType, ReconciliationReport, compare_totals
from onelineflow_recon.qbo import QboAuthError, QboCredentials, QboReader, QboReadError
from onelineflow_recon.reconcile import (
    find_duplicate_entity_ids,
    find_stalled_invoices,
    iter_posted_invoices,
    persist_report,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class RealmTarget:
    tenant_id: str
    realm_id: str
    environment: str
    access_token: str


def iter_active_realms(conn: psycopg.Connection, keyring: Keyring) -> Iterator[RealmTarget]:
    """Yield every active connection with its decrypted access token.

    A connection whose token cannot be decrypted is skipped with a loud log
    rather than raising: one tenant with a key-version problem must not stop the
    other 999 from being reconciled.
    """
    sql = """
        SELECT tenant_id, realm_id, environment,
               access_token_ct, wrapped_dek, key_version
          FROM qbo_connections
         WHERE status = 'active'
         ORDER BY tenant_id
    """
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql)
        for row in cur:
            try:
                token = keyring.open_token(
                    bytes(row["access_token_ct"]),
                    bytes(row["wrapped_dek"]),
                    row["key_version"],
                    str(row["tenant_id"]),
                )
            except DecryptionError:
                logger.error(
                    "cannot decrypt token for tenant=%s realm=%s key_version=%s; skipping",
                    row["tenant_id"],
                    row["realm_id"],
                    row["key_version"],
                )
                continue

            yield RealmTarget(
                tenant_id=str(row["tenant_id"]),
                realm_id=str(row["realm_id"]),
                environment=str(row["environment"]),
                access_token=token,
            )


def reconcile_realm(
    conn: psycopg.Connection,
    target: RealmTarget,
    since: date,
    until: date,
    *,
    reader: QboReader | None = None,
) -> tuple[list[Break], int]:
    """Reconcile one realm. Returns (breaks, invoices_checked)."""
    breaks: list[Break] = []
    checked = 0

    owned_reader = reader is None
    reader = reader or QboReader(
        QboCredentials(
            realm_id=target.realm_id,
            access_token=target.access_token,
            environment=target.environment,
        )
    )

    try:
        # Index QuickBooks by entity id. One dict for a month of one realm is a
        # few MB; the alternative is a QBO round trip per invoice, which at
        # 60k invoices would take hours and eat the rate limit.
        remote: dict[str, dict[str, Any]] = {}
        try:
            for bill in reader.iter_bills(since.isoformat(), until.isoformat()):
                remote[str(bill["Id"])] = bill
        except QboAuthError as exc:
            breaks.append(
                Break(
                    tenant_id=target.tenant_id,
                    invoice_id=None,
                    break_type=BreakType.STALLED,
                    detail=f"QuickBooks authorisation failed: {exc}",
                )
            )
            return breaks, 0
        except QboReadError as exc:
            breaks.append(
                Break(
                    tenant_id=target.tenant_id,
                    invoice_id=None,
                    break_type=BreakType.STALLED,
                    detail=f"QuickBooks read failed: {exc}",
                )
            )
            return breaks, 0

        seen_remote: set[str] = set()
        suspected_missing: list[tuple[str, dict[str, Any]]] = []

        for chunk in iter_posted_invoices(conn, since, until):
            for local in chunk:
                if str(local["tenant_id"]) != target.tenant_id:
                    continue
                if str(local.get("qbo_realm_id") or "") != target.realm_id:
                    continue

                checked += 1
                entity_id = str(local.get("qbo_entity_id") or "")
                if not entity_id:
                    # invoices_posted_has_entity should make this impossible.
                    breaks.append(
                        Break(
                            tenant_id=target.tenant_id,
                            invoice_id=str(local["id"]),
                            break_type=BreakType.MISSING_IN_QBO,
                            detail="Marked posted but carries no QuickBooks entity id",
                            local_minor=local["total_minor"],
                            currency=local["currency"],
                        )
                    )
                    continue

                match = remote.get(entity_id)
                if match is None:
                    suspected_missing.append((entity_id, local))
                    continue

                seen_remote.add(entity_id)
                mismatch = compare_totals(local, match)
                if mismatch:
                    breaks.append(mismatch)

        # Re-check suspected-missing bills by id before reporting them. A bill
        # whose TxnDate was edited falls outside the window and is not missing.
        if suspected_missing:
            confirmed = reader.fetch_bills_by_id([eid for eid, _ in suspected_missing])
            for entity_id, local in suspected_missing:
                found = confirmed.get(entity_id)
                if found is None:
                    breaks.append(
                        Break(
                            tenant_id=target.tenant_id,
                            invoice_id=str(local["id"]),
                            break_type=BreakType.MISSING_IN_QBO,
                            detail=(
                                f"Bill {entity_id} is posted locally but does not exist "
                                "in QuickBooks (confirmed by direct lookup)"
                            ),
                            local_minor=local["total_minor"],
                            currency=local["currency"],
                        )
                    )
                else:
                    seen_remote.add(entity_id)
                    mismatch = compare_totals(local, found)
                    if mismatch:
                        breaks.append(mismatch)

        # Bills in QuickBooks that carry our marker but that we do not know
        # about. Only ours: a tenant's manually entered bills are not orphans.
        for entity_id, bill in remote.items():
            if entity_id in seen_remote:
                continue
            note = str(bill.get("PrivateNote") or "")
            if "onelineFlow invoice" in note:
                breaks.append(
                    Break(
                        tenant_id=target.tenant_id,
                        invoice_id=None,
                        break_type=BreakType.ORPHAN_IN_QBO,
                        detail=(
                            f"QuickBooks bill {entity_id} carries our marker but has no "
                            f"matching local invoice ({note[:120]})"
                        ),
                    )
                )

        return breaks, checked
    finally:
        if owned_reader:
            reader.close()


def run_reconciliation(
    conn: psycopg.Connection,
    keyring: Keyring,
    *,
    since: date,
    until: date,
    stall_slo: timedelta = timedelta(hours=6),
    persist: bool = True,
) -> ReconciliationReport:
    """Reconcile every active realm in the window."""
    report = ReconciliationReport(run_started=datetime.now(timezone.utc))

    # Cross-tenant reads. Set explicitly and logged, matching the Node side's
    # withBypass contract.
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.bypass_rls', 'on', false)")

    # Local-only checks first: they need no QuickBooks calls, so they still
    # produce a useful report even if every realm is unreachable.
    report.breaks.extend(find_stalled_invoices(conn, stall_slo))
    report.breaks.extend(find_duplicate_entity_ids(conn, since))

    targets = list(iter_active_realms(conn, keyring))
    report.tenant_count = len({t.tenant_id for t in targets})

    for target in targets:
        try:
            breaks, checked = reconcile_realm(conn, target, since, until)
            report.breaks.extend(breaks)
            report.invoices_checked += checked
        except Exception as exc:  # noqa: BLE001 - one tenant must not fail the run
            logger.exception("reconciliation failed for tenant=%s", target.tenant_id)
            report.add(
                Break(
                    tenant_id=target.tenant_id,
                    invoice_id=None,
                    break_type=BreakType.STALLED,
                    detail=f"Reconciliation errored: {exc}",
                )
            )

    if persist:
        persist_report(conn, report)

    return report
