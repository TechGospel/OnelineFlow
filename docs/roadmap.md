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

## Not yet built

Ordered by what blocks a production launch.

### Blocking

_None. All four launch blockers are implemented and verified end to end._

### Important

1. **Reconciler QuickBooks fetch loop and CLI.** The comparison logic and SQL
   are done; the code that pages through QBO bills and the `onelineflow-recon`
   entrypoint are not.
2. **Partition maintenance scheduler.** `ensure_monthly_partitions` exists and is
   idempotent, but nothing calls it on a schedule. Three months of runway from
   the last manual run.
3. **Refresh-token expiry alerting.** `findExpiringSoon` is implemented and
   unused. Intuit's refresh tokens die after ~100 days of inactivity; a dormant
   connection fails silently.
4. **Broader integration coverage.** `scripts/smoke-relay.ts` now covers the
   outbox→queue path and object storage against the real stack, and it caught a
   bug unit tests could not (BullMQ rejects a custom job id containing ':', which
   would have stalled the entire pipeline). Still uncovered: the CAS transition
   race under genuine concurrency, and the posting worker's recovery path.

### Later

5. Review UI for `needs_review` invoices.
6. Vendor-creation flow (deliberately manual today — auto-creation on a typo
   permanently pollutes a tenant's chart of accounts).
7. Terraform / Helm deployment, HPA on queue depth.
8. Grafana dashboards and alert rules from the metrics already emitted.
9. Credit notes (`VendorCredit`) and multi-currency FX rate sourcing.
10. Per-tenant AI budget enforcement — the column and metric exist, the check
    before the model call does not.

## Load testing not yet done

The scale claims in the README are **design targets derived from the stated
requirements, not measured results.** Before trusting them, run:

- 250/sec sustained ingestion for one hour, watching outbox oldest-row age
- One tenant submitting 200k invoices while a second submits 10, confirming the
  small tenant's p99 does not degrade
- Chaos: kill the posting worker mid-`POST /bill` under load, then assert the
  reconciler reports zero `duplicate_in_qbo`
- Partition pruning verified via `EXPLAIN` on the dashboard queries at 100M rows
