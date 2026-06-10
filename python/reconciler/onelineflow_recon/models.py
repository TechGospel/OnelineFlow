"""Pure reconciliation logic — no database driver, no network.

Deliberately free of imports beyond the standard library so the money-comparison
rules can be tested without Postgres, and so a mistake in them shows up in a
millisecond unit test rather than in a nightly job.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any


class BreakType(str, Enum):
    """Categories of divergence, ordered roughly by severity."""

    #: Posted locally, absent in QuickBooks. Either never landed or was deleted.
    MISSING_IN_QBO = "missing_in_qbo"
    #: Two QuickBooks bills for one local invoice. The failure we work hardest
    #: to prevent; if it ever appears, something in the guard chain regressed.
    DUPLICATE_IN_QBO = "duplicate_in_qbo"
    #: Amounts differ. Usually an edit made directly in QuickBooks.
    AMOUNT_MISMATCH = "amount_mismatch"
    #: Stuck in a non-terminal state well past the SLO.
    STALLED = "stalled"
    #: In QuickBooks with our PrivateNote marker but unknown locally.
    ORPHAN_IN_QBO = "orphan_in_qbo"


@dataclass(frozen=True, slots=True)
class Break:
    tenant_id: str
    invoice_id: str | None
    break_type: BreakType
    detail: str
    local_minor: int | None = None
    remote_minor: int | None = None
    currency: str | None = None

    @property
    def delta_minor(self) -> int | None:
        """Signed difference: positive means QuickBooks is higher than us."""
        if self.local_minor is None or self.remote_minor is None:
            return None
        return self.remote_minor - self.local_minor

    def as_row(self) -> dict[str, Any]:
        return {
            "tenant_id": self.tenant_id,
            "invoice_id": self.invoice_id,
            "break_type": self.break_type.value,
            "detail": self.detail,
            "local_minor": self.local_minor,
            "remote_minor": self.remote_minor,
            "delta_minor": self.delta_minor,
            "currency": self.currency,
        }


@dataclass(slots=True)
class ReconciliationReport:
    run_started: datetime
    tenant_count: int = 0
    invoices_checked: int = 0
    breaks: list[Break] = field(default_factory=list)

    def add(self, item: Break) -> None:
        self.breaks.append(item)

    @property
    def by_type(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for b in self.breaks:
            counts[b.break_type.value] = counts.get(b.break_type.value, 0) + 1
        return counts

    @property
    def is_clean(self) -> bool:
        return not self.breaks

    def summary(self) -> str:
        if self.is_clean:
            return (
                f"Clean: {self.invoices_checked:,} invoices across "
                f"{self.tenant_count:,} tenants, no breaks."
            )
        parts = ", ".join(f"{k}={v}" for k, v in sorted(self.by_type.items()))
        return (
            f"{len(self.breaks):,} breaks over {self.invoices_checked:,} invoices "
            f"({self.tenant_count:,} tenants): {parts}"
        )


def minor_to_decimal(minor: int, exponent: int = 2) -> Decimal:
    """Convert integer minor units to an exact Decimal.

    Decimal, never float: ``float`` cannot represent ``1234.55`` exactly, and a
    reconciliation report that invents one-cent breaks is a report nobody reads.
    """
    return Decimal(minor).scaleb(-exponent)


def compare_totals(
    local: dict[str, Any],
    remote: dict[str, Any],
    exponent: int = 2,
) -> Break | None:
    """Compare one local invoice against its QuickBooks counterpart.

    ``remote['TotalAmt']`` arrives as a JSON number. It is converted via ``str``
    so the Decimal is built from the decimal representation rather than from the
    binary float — otherwise 1234.56 compares unequal to itself and every
    invoice looks like a break.
    """
    remote_total = remote.get("TotalAmt")
    if remote_total is None:
        return Break(
            tenant_id=str(local["tenant_id"]),
            invoice_id=str(local["id"]),
            break_type=BreakType.AMOUNT_MISMATCH,
            detail="QuickBooks bill has no TotalAmt",
            local_minor=local["total_minor"],
            currency=local["currency"],
        )

    remote_minor = int(Decimal(str(remote_total)).scaleb(exponent).to_integral_value())
    local_minor = int(local["total_minor"])

    if remote_minor == local_minor:
        return None

    return Break(
        tenant_id=str(local["tenant_id"]),
        invoice_id=str(local["id"]),
        break_type=BreakType.AMOUNT_MISMATCH,
        detail=(
            f"Local {minor_to_decimal(local_minor, exponent)} vs QuickBooks "
            f"{minor_to_decimal(remote_minor, exponent)} "
            f"(bill {local['qbo_entity_id']})"
        ),
        local_minor=local_minor,
        remote_minor=remote_minor,
        currency=local["currency"],
    )
