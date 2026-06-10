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

## Not yet built

Ordered by what blocks a production launch.

### Blocking

1. **Outbox relay process.** The outbox is written and drained-from correctly,
   but no daemon runs the loop. Until it exists, ingestion writes events that
   nothing consumes. Smallest missing piece with the largest impact.
2. **Document upload to object storage.** `POST /v1/invoices` records the
   storage key and fingerprint but does not yet write the bytes to S3/MinIO. The
   extraction worker's `fetchDocument` will 404.
3. **JWT verification plugin.** `auth.ts` reads `req.auth` and every rule around
   it is implemented; the plugin that populates it from a verified token is not
   wired. **The API is unauthenticated as it stands.**
4. **Approval endpoints.** The state machine and approval-limit checks exist;
   `POST /v1/invoices/:id/approve` and `/reject` do not.

### Important

5. **Reconciler QuickBooks fetch loop and CLI.** The comparison logic and SQL
   are done; the code that pages through QBO bills and the `onelineflow-recon`
   entrypoint are not.
6. **Partition maintenance scheduler.** `ensure_monthly_partitions` exists and is
   idempotent, but nothing calls it on a schedule. Three months of runway from
   the last manual run.
7. **Refresh-token expiry alerting.** `findExpiringSoon` is implemented and
   unused. Intuit's refresh tokens die after ~100 days of inactivity; a dormant
   connection fails silently.
8. **Integration tests against real Postgres and Redis.** Unit coverage is good;
   the interaction between CAS transitions, the outbox and the fair gate is only
   covered by reasoning.

### Later

9. Review UI for `needs_review` invoices.
10. Vendor-creation flow (deliberately manual today — auto-creation on a typo
    permanently pollutes a tenant's chart of accounts).
11. Terraform / Helm deployment, HPA on queue depth.
12. Grafana dashboards and alert rules from the metrics already emitted.
13. Credit notes (`VendorCredit`) and multi-currency FX rate sourcing.
14. Per-tenant AI budget enforcement — the column and metric exist, the check
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
