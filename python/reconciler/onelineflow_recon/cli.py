"""``onelineflow-recon`` entrypoint.

Exit codes are the contract with whatever schedules this:

* ``0`` — ran successfully, no breaks.
* ``1`` — the run itself failed (could not connect, bad configuration).
* ``2`` — ran successfully and FOUND breaks.

Separating 1 from 2 matters. "The reconciler is broken" and "the reconciler
found a discrepancy" need different people woken up, and collapsing them into a
single non-zero exit guarantees the wrong response to at least one of them.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date, datetime, timedelta

import psycopg

from onelineflow_recon.crypto import DecryptionError, Keyring
from onelineflow_recon.models import BreakType
from onelineflow_recon.runner import run_reconciliation

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_BREAKS_FOUND = 2

logger = logging.getLogger("onelineflow_recon")


def _parse_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Expected YYYY-MM-DD, got {value!r}") from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="onelineflow-recon",
        description="Reconcile onelineFlow invoices against QuickBooks Online.",
    )
    parser.add_argument(
        "--since",
        type=_parse_date,
        help="Window start (inclusive). Defaults to 7 days before --until.",
    )
    parser.add_argument(
        "--until",
        type=_parse_date,
        help="Window end (exclusive). Defaults to tomorrow, so today is covered.",
    )
    parser.add_argument(
        "--stall-hours",
        type=float,
        default=6.0,
        help="Flag non-terminal invoices older than this. Default 6.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report without writing reconciliation_runs / _breaks.",
    )
    parser.add_argument(
        "--fail-on-breaks",
        action="store_true",
        help="Exit 2 when breaks are found. Use in a scheduled job that alerts.",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def _load_keyring() -> Keyring:
    root = os.environ.get("ENCRYPTION_ROOT_KEY")
    if not root:
        raise SystemExit("ENCRYPTION_ROOT_KEY is not set")
    version = int(os.environ.get("ENCRYPTION_KEY_VERSION", "1"))

    # Prior versions during a rotation: ENCRYPTION_ROOT_KEY_V1=..., _V2=...
    previous: dict[int, str] = {}
    for name, value in os.environ.items():
        if name.startswith("ENCRYPTION_ROOT_KEY_V") and value:
            suffix = name.removeprefix("ENCRYPTION_ROOT_KEY_V")
            if suffix.isdigit():
                previous[int(suffix)] = value

    try:
        return Keyring.from_env(root, version, previous)
    except DecryptionError as exc:
        raise SystemExit(f"Invalid encryption configuration: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    # The replica is preferred: a full-window scan competing with live posting
    # on the primary is exactly the wrong trade at month-end close.
    dsn = os.environ.get("DATABASE_REPLICA_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        logger.error("DATABASE_URL is not set")
        return EXIT_ERROR

    until: date = args.until or (date.today() + timedelta(days=1))
    since: date = args.since or (until - timedelta(days=7))
    if since >= until:
        logger.error("--since (%s) must be before --until (%s)", since, until)
        return EXIT_ERROR

    keyring = _load_keyring()

    try:
        with psycopg.connect(dsn, application_name="onelineflow-recon") as conn:
            report = run_reconciliation(
                conn,
                keyring,
                since=since,
                until=until,
                stall_slo=timedelta(hours=args.stall_hours),
                persist=not args.dry_run,
            )
    except psycopg.Error:
        logger.exception("database error during reconciliation")
        return EXIT_ERROR

    _print_report(report, since, until, dry_run=args.dry_run)

    if report.is_clean:
        return EXIT_OK
    return EXIT_BREAKS_FOUND if args.fail_on_breaks else EXIT_OK


def _print_report(report, since: date, until: date, *, dry_run: bool) -> None:  # noqa: ANN001
    out = sys.stdout
    out.write(f"\nReconciliation {since} .. {until}{' (dry run)' if dry_run else ''}\n")
    out.write(f"{report.summary()}\n")

    if report.is_clean:
        return

    # Worst first. An operator reading top-down should hit the thing that means
    # money moved twice before the thing that means a job is slow.
    severity = {
        BreakType.DUPLICATE_IN_QBO: 0,
        BreakType.MISSING_IN_QBO: 1,
        BreakType.AMOUNT_MISMATCH: 2,
        BreakType.ORPHAN_IN_QBO: 3,
        BreakType.STALLED: 4,
    }
    ordered = sorted(report.breaks, key=lambda b: severity.get(b.break_type, 99))

    out.write("\n")
    for item in ordered[:100]:
        invoice = item.invoice_id or "-"
        out.write(f"  [{item.break_type.value:<17}] {invoice}  {item.detail}\n")

    if len(ordered) > 100:
        out.write(f"  ... and {len(ordered) - 100} more (see reconciliation_breaks)\n")
    out.write("\n")


if __name__ == "__main__":
    sys.exit(main())
