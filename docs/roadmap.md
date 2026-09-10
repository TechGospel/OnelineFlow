# Roadmap

An honest account of what exists and what does not, so nobody discovers a gap
during an incident.

## Implemented and verified

| Area                                                            | State                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| Domain core (Money, errors, state machine, idempotency, config) | Complete, 48 tests                                              |
| Envelope encryption + key rotation                              | Complete, 16 tests                                              |
| Database schema, partitioning, RLS                              | Complete, 4 migrations applied to PG 16, 7 isolation assertions |
| Migration runner (checksums, advisory lock)                     | Complete                                                        |
| QuickBooks client, fault classification, rate limiter           | Complete, 36 tests                                              |
| Bill mapper with the arithmetic invariant                       | Complete, 17 tests                                              |
| AI providers + consensus gate                                   | Complete, 18 tests                                              |
| Queue topology + per-tenant fairness                            | Complete                                                        |
| Posting worker (all four duplicate guards)                      | Complete                                                        |
| Extraction worker                                               | Complete                                                        |
| API: ingest, OAuth, Intuit webhooks                             | Complete                                                        |
| Observability: logging, metrics, shutdown                       | Complete                                                        |
| Deluge tenant adapter + single-tenant direct path               | Complete                                                        |
| Reconciler comparison logic                                     | Complete, 14 tests                                              |
| **Outbox relay daemon**                                         | Complete, verified end to end against real Postgres + Redis     |
| **Document object storage**                                     | Complete, content-addressed, round-trip verified                |
| **JWT verification plugin**                                     | Complete, 16 tests — the API is now authenticated               |
| **Approval / rejection endpoints**                              | Complete, limits and overrides enforced server-side             |
| **Reconciler QBO fetch loop + CLI**                             | Complete, paginating and self-throttling, 31 Python tests       |
| **Cross-language crypto interop**                               | Complete, verified against fixtures from the real Node sealer   |
| **Maintenance scheduler**                                       | Complete, partitions + token expiry + stall detection, 10 tests |
| **Concurrency / recovery integration tests**                    | Complete, 14 checks against real Postgres                       |
| **Per-tenant AI budget enforcement**                            | Complete, Redis counter + PG reconciliation, degrade-then-stop  |
| **Credit notes (VendorCredit) + FX**                            | Complete, 19 tests                                              |
| **Vendor link / create flow**                                   | Complete, suggestions-first to prevent duplicates               |
| **Grafana dashboard + Prometheus alerts**                       | Complete, 17 panels, 14 alert rules                             |
| **Helm chart with queue-depth autoscaling**                     | Complete, `helm lint` clean, 15 resources render                |
| **Review UI**                                                   | Complete, server-rendered, escaping verified end to end         |

## Not yet built

Ordered by what blocks a production launch.

### Blocking

_None. All four launch blockers are implemented and verified end to end._

### Important

_None. All four are implemented and verified._

### Later

_None. All six are implemented and verified._

## Known operational caveats

- **Migration 0005 backfill is unbatched.** It rewrites every `invoices` and
  `invoice_line_items` row whose `created_at` carries sub-millisecond precision.
  Fine at current volume; at production scale it must be batched per partition.
- **The scheduler is single-replica by design.** Every task is idempotent, so a
  second replica is harmless but pointless. Alert on the `/healthz` staleness
  check rather than running two.
- **Partition detaching is disabled by default** (`retainMonths: null`). Ageing
  out financial history is an explicit human decision, not a timer.

## Next: load testing (now the highest-value remaining work)

The scale claims in the README are **design targets derived from the stated
requirements, not measured results.** Before trusting them, run:

- 250/sec sustained ingestion for one hour, watching outbox oldest-row age
- One tenant submitting 200k invoices while a second submits 10, confirming the
  small tenant's p99 does not degrade
- Chaos: kill the posting worker mid-`POST /bill` under load, then assert the
  reconciler reports zero `duplicate_in_qbo`
- Partition pruning verified via `EXPLAIN` on the dashboard queries at 100M rows
