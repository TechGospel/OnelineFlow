"""Nightly reconciliation between onelineFlow and QuickBooks Online.

Why this exists
---------------
Every guard in the posting path reduces the probability of divergence; none of
them makes it zero. Networks partition mid-write, operators force-repost, users
delete bills directly in QuickBooks. Reconciliation is the control that *detects*
divergence rather than preventing it, and in an accounting system detection is
not optional — it is what makes the whole pipeline auditable.

Design notes
------------
* Runs against a read replica with ``app.bypass_rls`` set. It is one of only two
  code paths in the platform allowed to see across tenants, and every run is
  logged.
* Money is compared as integer minor units, never floats. A float comparison
  would produce phantom breaks at the cent level and train operators to ignore
  the report.
* Streams in chunks. At ~2M invoices/day a naive ``SELECT *`` for a month is
  tens of gigabytes.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from datetime import date, timedelta
from typing import Any

import psycopg
from psycopg.rows import dict_row

from onelineflow_recon.models import (
    Break,
    BreakType,
    ReconciliationReport,
    compare_totals,
    minor_to_decimal,
)

__all__ = [
    "Break",
    "BreakType",
    "ReconciliationReport",
    "compare_totals",
    "find_duplicate_entity_ids",
    "find_stalled_invoices",
    "iter_posted_invoices",
    "minor_to_decimal",
    "persist_report",
]

logger = logging.getLogger(__name__)

# Chunk size for streaming. Large enough to amortise round trips, small enough
# that one chunk fits comfortably in memory alongside the QBO page.
CHUNK_SIZE = 5_000


def iter_posted_invoices(
    conn: psycopg.Connection,
    since: date,
    until: date,
    chunk_size: int = CHUNK_SIZE,
) -> Iterator[list[dict[str, Any]]]:
    """Stream posted invoices in the window, chunk by chunk.

    A server-side named cursor keeps the result set on the server; without it
    psycopg buffers every row client-side and a month's data exhausts memory.
    """
    sql = """
        SELECT i.id, i.tenant_id, i.qbo_realm_id, i.qbo_entity_id,
               i.total_minor, i.currency, i.invoice_number, i.posted_at
          FROM invoices i
         WHERE i.status = 'posted'
           AND i.created_at >= %(since)s
           AND i.created_at <  %(until)s
         ORDER BY i.tenant_id, i.created_at
    """
    with conn.cursor(name="recon_posted", row_factory=dict_row) as cur:
        cur.itersize = chunk_size
        cur.execute(sql, {"since": since, "until": until})
        chunk: list[dict[str, Any]] = []
        for row in cur:
            chunk.append(row)
            if len(chunk) >= chunk_size:
                yield chunk
                chunk = []
        if chunk:
            yield chunk


def find_stalled_invoices(
    conn: psycopg.Connection,
    slo: timedelta,
) -> list[Break]:
    """Invoices sitting in a non-terminal state past the SLO.

    ``needs_review`` and ``pending_approval`` are excluded: those are waiting on
    a human, which is a business delay, not a system fault. Flagging them would
    bury the real breaks in noise.
    """
    sql = """
        SELECT id, tenant_id, status, currency, total_minor,
               EXTRACT(EPOCH FROM (now() - updated_at))::bigint AS age_seconds
          FROM invoices
         WHERE status IN ('received', 'extracting', 'extracted', 'approved', 'posting')
           AND updated_at < now() - %(slo)s::interval
         ORDER BY updated_at
         LIMIT 10000
    """
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, {"slo": slo})
        return [
            Break(
                tenant_id=str(r["tenant_id"]),
                invoice_id=str(r["id"]),
                break_type=BreakType.STALLED,
                detail=(
                    f"Stuck in '{r['status']}' for "
                    f"{int(r['age_seconds']) // 3600}h "
                    f"{(int(r['age_seconds']) % 3600) // 60}m"
                ),
                local_minor=r["total_minor"],
                currency=r["currency"],
            )
            for r in cur
        ]


def find_duplicate_entity_ids(conn: psycopg.Connection, since: date) -> list[Break]:
    """Two local invoices pointing at one QuickBooks bill, or vice versa.

    Either direction means a guard failed. This query is the canary for a
    regression in the posting path, so it runs even when everything looks fine.
    """
    sql = """
        SELECT tenant_id, qbo_realm_id, qbo_entity_id,
               count(*) AS n, array_agg(id::text) AS invoice_ids
          FROM invoices
         WHERE status = 'posted'
           AND qbo_entity_id IS NOT NULL
           AND created_at >= %(since)s
         GROUP BY tenant_id, qbo_realm_id, qbo_entity_id
        HAVING count(*) > 1
    """
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, {"since": since})
        return [
            Break(
                tenant_id=str(r["tenant_id"]),
                invoice_id=r["invoice_ids"][0],
                break_type=BreakType.DUPLICATE_IN_QBO,
                detail=(
                    f"{r['n']} local invoices share QuickBooks bill "
                    f"{r['qbo_entity_id']}: {', '.join(r['invoice_ids'])}"
                ),
            )
            for r in cur
        ]


def persist_report(conn: psycopg.Connection, report: ReconciliationReport) -> None:
    """Write the run and its breaks.

    Every run is recorded, including clean ones. A missing run is itself a
    signal — "no breaks reported" and "reconciliation did not run" must not look
    the same on a dashboard.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO reconciliation_runs
              (started_at, finished_at, tenant_count, invoices_checked, break_count, summary)
            VALUES (%s, now(), %s, %s, %s, %s)
            RETURNING id
            """,
            (
                report.run_started,
                report.tenant_count,
                report.invoices_checked,
                len(report.breaks),
                report.summary(),
            ),
        )
        row = cur.fetchone()
        run_id = row[0] if row else None

        if report.breaks:
            cur.executemany(
                """
                INSERT INTO reconciliation_breaks
                  (run_id, tenant_id, invoice_id, break_type, detail,
                   local_minor, remote_minor, delta_minor, currency)
                VALUES (%(run_id)s, %(tenant_id)s, %(invoice_id)s, %(break_type)s,
                        %(detail)s, %(local_minor)s, %(remote_minor)s,
                        %(delta_minor)s, %(currency)s)
                """,
                [{**b.as_row(), "run_id": run_id} for b in report.breaks],
            )
    conn.commit()
