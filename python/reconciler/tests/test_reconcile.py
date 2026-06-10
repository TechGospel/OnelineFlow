"""Tests for the reconciliation comparison logic.

The database-touching functions are covered by integration tests; these cover
the pure logic, which is where the money correctness lives.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from onelineflow_recon.models import (
    Break,
    BreakType,
    ReconciliationReport,
    compare_totals,
    minor_to_decimal,
)

LOCAL = {
    "id": "aaaaaaaa-0000-4000-8000-000000000001",
    "tenant_id": "11111111-1111-4111-8111-111111111111",
    "qbo_entity_id": "42",
    "total_minor": 123456,
    "currency": "USD",
}


class TestMinorToDecimal:
    def test_two_decimal_currency(self) -> None:
        assert minor_to_decimal(123456) == Decimal("1234.56")

    def test_zero_decimal_currency(self) -> None:
        assert minor_to_decimal(150000, exponent=0) == Decimal("150000")

    def test_three_decimal_currency(self) -> None:
        assert minor_to_decimal(1500, exponent=3) == Decimal("1.500")

    def test_negative(self) -> None:
        assert minor_to_decimal(-4250) == Decimal("-42.50")


class TestCompareTotals:
    def test_matching_totals_produce_no_break(self) -> None:
        assert compare_totals(LOCAL, {"TotalAmt": 1234.56}) is None

    def test_one_cent_difference_is_a_break(self) -> None:
        # Not a rounding nuance — a cent is a real difference in a ledger.
        result = compare_totals(LOCAL, {"TotalAmt": 1234.57})
        assert result is not None
        assert result.break_type is BreakType.AMOUNT_MISMATCH
        assert result.delta_minor == 1

    def test_float_representation_does_not_invent_a_break(self) -> None:
        # 1234.56 is not exactly representable as a binary float. Building the
        # Decimal from str() rather than from the float is what prevents a
        # phantom break here.
        assert compare_totals(LOCAL, {"TotalAmt": 1234.56}) is None

    def test_missing_remote_total_is_a_break(self) -> None:
        result = compare_totals(LOCAL, {})
        assert result is not None
        assert "no TotalAmt" in result.detail

    def test_delta_sign_indicates_direction(self) -> None:
        higher = compare_totals(LOCAL, {"TotalAmt": 1300.00})
        lower = compare_totals(LOCAL, {"TotalAmt": 1200.00})
        assert higher is not None and higher.delta_minor is not None
        assert lower is not None and lower.delta_minor is not None
        assert higher.delta_minor > 0  # QuickBooks is higher than us
        assert lower.delta_minor < 0

    def test_zero_decimal_currency(self) -> None:
        jpy = {**LOCAL, "currency": "JPY", "total_minor": 150000}
        assert compare_totals(jpy, {"TotalAmt": 150000}, exponent=0) is None


class TestBreak:
    def test_delta_is_none_when_one_side_is_missing(self) -> None:
        b = Break(
            tenant_id="t",
            invoice_id="i",
            break_type=BreakType.MISSING_IN_QBO,
            detail="gone",
            local_minor=100,
        )
        assert b.delta_minor is None

    def test_as_row_is_serialisable(self) -> None:
        b = Break(
            tenant_id="t",
            invoice_id="i",
            break_type=BreakType.AMOUNT_MISMATCH,
            detail="d",
            local_minor=100,
            remote_minor=150,
            currency="USD",
        )
        row = b.as_row()
        assert row["delta_minor"] == 50
        assert row["break_type"] == "amount_mismatch"


class TestReport:
    def _report(self) -> ReconciliationReport:
        return ReconciliationReport(run_started=datetime.now(timezone.utc))

    def test_clean_report(self) -> None:
        r = self._report()
        r.invoices_checked = 1000
        r.tenant_count = 5
        assert r.is_clean
        assert "no breaks" in r.summary()

    def test_counts_by_type(self) -> None:
        r = self._report()
        r.add(Break("t", "a", BreakType.MISSING_IN_QBO, "x"))
        r.add(Break("t", "b", BreakType.MISSING_IN_QBO, "y"))
        r.add(Break("t", "c", BreakType.DUPLICATE_IN_QBO, "z"))
        assert r.by_type == {"missing_in_qbo": 2, "duplicate_in_qbo": 1}
        assert not r.is_clean
        assert "duplicate_in_qbo=1" in r.summary()
