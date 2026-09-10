"""Read-only QuickBooks client for the reconciler.

Strictly read-only, and that is a design constraint rather than an accident: the
reconciler exists to *observe* divergence. Giving it write access would make it
capable of "fixing" a break automatically, which is precisely the behaviour you
do not want from an unattended job touching a general ledger.

Two things this has to get right that a naive client does not:

* **Pagination.** QBO caps a query at 1000 rows and offers no cursor — you page
  with ``STARTPOSITION``/``MAXRESULTS``. A tenant with 60k bills in a month is 60
  round trips, and stopping early would report every unfetched bill as missing.
* **Rate limiting.** The reconciler shares the ~500 req/min per-realm budget with
  the live posting workers. Running flat out at month-end close would throttle
  the path that actually moves money, so it self-limits well below the ceiling.
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
PAGE_SIZE = 1000
MINOR_VERSION = "75"


@dataclass(frozen=True, slots=True)
class QboCredentials:
    realm_id: str
    access_token: str
    environment: str

    @property
    def base_url(self) -> str:
        return (
            "https://quickbooks.api.intuit.com"
            if self.environment == "production"
            else "https://sandbox-quickbooks.api.intuit.com"
        )


class QboReadError(Exception):
    """A QuickBooks read failed in a way the caller should surface, not retry."""


class QboAuthError(QboReadError):
    """The tenant's grant is dead. Skip this tenant; do not fail the whole run."""


def escape_literal(value: str) -> str:
    """Escape a value for a QBO query string literal.

    QBO's query language has no bind parameters. Mirrors ``escapeQboLiteral`` in
    the Node client: escape the escape character first, then the quote, and
    refuse control characters rather than stripping them.
    """
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise QboReadError("Refusing to build a QBO query containing control characters")
    return value.replace("\\", "\\\\").replace("'", "\\'")


class QboReader:
    """Paginating, self-throttling reader for one realm."""

    def __init__(
        self,
        credentials: QboCredentials,
        client: httpx.Client | None = None,
        *,
        requests_per_minute: int = 60,
        timeout_seconds: float = 30.0,
        max_retries: int = 4,
    ) -> None:
        self._creds = credentials
        self._client = client or httpx.Client(timeout=timeout_seconds)
        self._owns_client = client is None
        # Deliberately far below Intuit's ~500/min ceiling. The reconciler is
        # background work and must never crowd out live posting.
        self._min_interval = 60.0 / max(1, requests_per_minute)
        self._last_request = 0.0
        self._max_retries = max_retries

    def __enter__(self) -> QboReader:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_request = time.monotonic()

    def _request(self, query: str) -> dict[str, Any]:
        url = f"{self._creds.base_url}/v3/company/{self._creds.realm_id}/query"
        params = {"query": query, "minorversion": MINOR_VERSION}
        headers = {
            "Authorization": f"Bearer {self._creds.access_token}",
            "Accept": "application/json",
        }

        for attempt in range(self._max_retries):
            self._throttle()
            try:
                response = self._client.get(url, params=params, headers=headers)
            except httpx.RequestError as exc:
                if attempt == self._max_retries - 1:
                    raise QboReadError(f"QuickBooks unreachable: {exc}") from exc
                self._backoff(attempt)
                continue

            if response.status_code == 401:
                # Not retryable: the token is dead and this job cannot refresh it
                # safely. Intuit rotates refresh tokens, and racing the live
                # workers for a refresh would invalidate the token they hold.
                raise QboAuthError(
                    f"Realm {self._creds.realm_id} rejected the access token"
                )

            if response.status_code == 429 or response.status_code >= 500:
                if attempt == self._max_retries - 1:
                    raise QboReadError(
                        f"QuickBooks returned {response.status_code} after "
                        f"{self._max_retries} attempts"
                    )
                self._backoff(attempt, response.headers.get("Retry-After"))
                continue

            try:
                body: dict[str, Any] = response.json()
            except ValueError as exc:
                raise QboReadError("QuickBooks returned a non-JSON body") from exc

            # QBO returns faults inside HTTP 200 bodies. Checking status alone
            # would treat a fault as an empty result set — and an empty result
            # set makes every local invoice look missing.
            fault = body.get("Fault")
            if fault:
                errors = fault.get("Error") or [{}]
                first = errors[0] if isinstance(errors, list) else errors
                code = str(first.get("code", "unknown"))
                message = first.get("Message", "")
                if code in {"3200", "3100", "100"}:
                    raise QboAuthError(f"QuickBooks auth fault {code}: {message}")
                raise QboReadError(f"QuickBooks fault {code}: {message}")

            if response.status_code >= 400:
                raise QboReadError(f"QuickBooks returned {response.status_code}")

            return body

        raise QboReadError("Exhausted retries without a response")

    def _backoff(self, attempt: int, retry_after: str | None = None) -> None:
        if retry_after:
            try:
                time.sleep(min(60.0, float(retry_after)))
                return
            except ValueError:
                pass
        # Full jitter, matching the Node side. Undithered backoff synchronises
        # every client onto the same retry instants.
        ceiling = min(30.0, 0.5 * (2**attempt))
        time.sleep(random.uniform(0, ceiling))  # noqa: S311 - jitter, not crypto

    def iter_bills(self, since: str, until: str) -> Iterator[dict[str, Any]]:
        """Yield every Bill with ``TxnDate`` in ``[since, until)``.

        Pages until a short page arrives. Stopping on an empty page instead would
        loop forever on a realm whose count is an exact multiple of the page size.
        """
        start = 1
        fetched = 0

        while True:
            query = (
                "select Id, DocNumber, TotalAmt, TxnDate, VendorRef, SyncToken, "
                "PrivateNote from Bill "
                f"where TxnDate >= '{escape_literal(since)}' "
                f"and TxnDate < '{escape_literal(until)}' "
                f"startposition {start} maxresults {PAGE_SIZE}"
            )
            body = self._request(query)
            rows = body.get("QueryResponse", {}).get("Bill", [])

            if not rows:
                break

            yield from rows
            fetched += len(rows)

            if len(rows) < PAGE_SIZE:
                break
            start += PAGE_SIZE

            # A realm returning unbounded pages means our window predicate is
            # wrong. Fail loudly rather than paging forever.
            if fetched > 5_000_000:
                raise QboReadError(
                    f"Realm {self._creds.realm_id} returned over 5M bills; aborting"
                )

        logger.info(
            "fetched %d bills from realm %s (%s..%s)",
            fetched,
            self._creds.realm_id,
            since,
            until,
        )

    def fetch_bills_by_id(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        """Fetch specific bills by id, batched into IN clauses.

        Used to confirm a suspected break rather than trusting the bulk window —
        a bill edited to a date outside the window would otherwise look missing.
        """
        found: dict[str, dict[str, Any]] = {}
        batch_size = 100

        for i in range(0, len(ids), batch_size):
            batch = ids[i : i + batch_size]
            joined = ", ".join(f"'{escape_literal(b)}'" for b in batch)
            body = self._request(
                f"select Id, DocNumber, TotalAmt, TxnDate, SyncToken from Bill "
                f"where Id in ({joined})"
            )
            for row in body.get("QueryResponse", {}).get("Bill", []):
                found[str(row["Id"])] = row

        return found
