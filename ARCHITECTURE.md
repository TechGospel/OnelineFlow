# Architecture

Every significant decision here traces back to one of three constraints:

1. **It moves money.** A wrong bill in a general ledger is an audit finding, not
   a bug report. Correctness beats throughput, availability and elegance.
2. **~2M invoices/day across 1,000+ tenants.** Anything O(tenants) per request,
   or unbounded per day, will not survive.
3. **QuickBooks is rate-limited per realm and eventually consistent.** We do not
   control it, cannot transact with it, and must assume it will time out
   mid-write.

---

## 1. Why Deluge is not the engine

The obvious design — Zoho Creator holds the data, Deluge posts to QuickBooks —
works well for one company. It does not survive the stated scale:

- Creator's API call quotas are per-org and well below 2M documents/day.
- Deluge has per-invocation statement and execution ceilings; a bulk sweep dies
  halfway and leaves ambiguous state.
- Idempotency logic would be duplicated into every tenant's app, so a fix has to
  be deployed a thousand times.

So Deluge is demoted to the **tenant adapter**: UI, tenant-specific business
rules, human approval. The transaction engine is a Node.js/TypeScript core.

The single-tenant direct-Deluge path is kept in `deluge/functions/QBO_DirectPost.dg`
because it remains the right answer for a small deployment, and it carries the
same guards.

---

## 2. Multi-tenancy: shared schema + RLS

**Considered:** database-per-tenant, schema-per-tenant, shared schema + RLS.

Database-per-tenant gives the strongest isolation and is unmanageable at 1,000+
tenants: 1,000 connection pools, 1,000 migration runs, and a schema change that
takes a week. Schema-per-tenant has the same migration problem with weaker
isolation.

**Chosen:** shared schema with Postgres RLS keyed on `app.tenant_id`.

What makes it trustworthy rather than merely present:

| Property               | Mechanism                                            | Failure mode without it                                |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Fail closed            | `nullif(current_setting(...), '')::uuid` → NULL      | Missing context returns _all_ rows                     |
| Owner is not exempt    | `FORCE ROW LEVEL SECURITY`                           | Migrations and ORMs bypass silently                    |
| App cannot self-exempt | App role is non-superuser, owns nothing              | `SET ROLE` defeats everything                          |
| Context always cleared | `finally` in `withTenant`, destroy client on failure | Pooled connection leaks tenant A's context to tenant B |
| Bypass is auditable    | `withBypass(reason, …)` requires a reason            | Cross-tenant reads become invisible                    |

`db/verify_rls.sql` asserts all of this as a **non-superuser** in CI. Testing RLS
as a superuser passes while proving nothing — that trap is why so many RLS
deployments are quietly broken.

---

## 3. Partitioning

`invoices` reaches ~730M rows in a year. A single heap means index bloat,
autovacuum falling behind, and a retention `DELETE` that locks for hours.

**Chosen:** monthly `RANGE` partitions on `created_at` for `invoices`,
`invoice_line_items`, `audit_log` and `qbo_api_calls`.

Consequences worth naming:

- Retention becomes `DETACH PARTITION` — instantaneous — rather than deleting
  60M rows.
- Line items are partitioned on the **same key**, with `created_at` denormalised
  onto the child, so partition-wise joins work.
- Every query carries `created_at`, which is why the invoice repository takes
  `createdAt` alongside `id`. That is not redundancy; without it Postgres scans
  every partition.
- A `UNIQUE` index on a partitioned table must include the partition key, which
  would let the same invoice re-enter in a new month. So business-key uniqueness
  lives in the small unpartitioned `invoice_dedup_keys` table instead.
- `ensure_monthly_partitions` runs 3 months ahead. A scheduler that dies has a
  full quarter of runway — the single most common way a partitioned system falls
  over at 00:00 on the 1st.

The hot working set is tiny relative to the total, because ~99% of rows are
`posted` after a month. Partial indexes restricted to non-terminal statuses stay
in the low millions.

---

## 4. Exactly-once posting

This is the heart of the system. See the guard table in the README; here is the
reasoning behind the ordering.

```
                    ┌─────────────────────────────────┐
   job arrives ────▶│ Guard 2: qbo_entity_id present? │──yes──▶ done
                    └────────────┬────────────────────┘
                                 │ no
                    ┌────────────▼────────────────────┐
                    │ status == 'posting' already?    │
                    └────────┬───────────────┬────────┘
                        yes  │               │ no
              ┌──────────────▼──────┐   ┌────▼──────────────────────┐
              │ Guard 4: ask QBO    │   │ Guard 1: CAS claim        │
              │ "does this exist?"  │   │ approved → posting, v=N   │
              └──────┬──────────┬───┘   └────┬──────────────────────┘
                found│          │not found   │
                     ▼          └────────────┤
                  link &                     ▼
                  reconcile          POST /bill?requestid=… (Guard 3)
```

**Why `posting` is entered before the HTTP call.** It has to be. If we called
QuickBooks first and then recorded intent, a crash between the two would leave
no evidence that a write was ever attempted, and the retry would post again.

**Why a timed-out write is not retried blindly.** A timeout means the outcome is
unknown, not failed. QuickBooks may have committed. Guard 4 asks before acting.

**Why unknown errors default to non-retryable.** An unknown error is by
definition one nobody reasoned about. Retrying risks duplicating an invisible
side effect; parking costs one manual review. In a ledger, that trade is not
close. `isRetryable()` returns `false` for anything that is not an `AppError`.

**Why `post_attempt_epoch` exists.** Bumping it is the only way to defeat
Intuit's server-side deduplication and force a genuine re-post. It is therefore
an audited admin action, not something a retry loop can reach.

---

## 5. Transactional outbox

"Update the invoice **and** enqueue a job" spans Postgres and Redis. There is no
distributed transaction; under load, one will eventually happen without the
other. That is not hypothetical — it is a weekly occurrence at scale.

**Chosen:** only ever write to Postgres. A relay drains committed `outbox` rows
into Redis.

- Delivery is at-least-once, which is fine because every consumer is idempotent.
- BullMQ deduplicates on a deterministic `jobId`, so a row relayed twice
  produces one job.
- Multiple relay replicas drain concurrently via `FOR UPDATE SKIP LOCKED` —
  without it the relay degenerates into a single serialised consumer.
- The alert that matters is **oldest unpublished row age**, not backlog count. A
  relay that is stuck on one poisoned row shows a flat small backlog and a
  growing age.

---

## 6. Rate limiting and fairness

Two distinct problems, often confused.

**Per-realm rate limiting** protects _QuickBooks_. Intuit's ~500 req/min is per
realm, shared by our whole fleet. Forty pods each locally allowing a "safe"
100 rpm sends 4,000 rpm. So the budget is a Redis token bucket keyed by realm,
refilled lazily inside a Lua script — atomic, one round trip, no read-modify-write
race. A 429 calls `penalise()`, which drains the bucket so the **whole fleet**
backs off together.

**Per-tenant fairness** protects _other tenants_. One company dumping 200,000
invoices at month-end must not put a company with three invoices behind them.
`TenantFairGate` caps in-flight jobs per tenant across the fleet; a job that
cannot get a slot is **deferred**, not failed. Both use lease TTLs so a crashed
worker releases its slot automatically instead of leaking capacity forever.

---

## 7. Token storage

A QuickBooks refresh token grants indefinite read/write access to a company's
general ledger. The threat model is a database dump, a leaked replica, or a
backup on a laptop.

**Chosen:** envelope encryption. Per-connection random DEK, AES-256-GCM, DEK
wrapped by a versioned root key held outside Postgres. Tenant id and purpose are
bound in as **AAD**, so a row copied into another tenant's record fails to
decrypt rather than silently working.

The rotation path matters as much as the encryption: prior key versions stay
loaded so existing rows keep opening while new writes use the current version.
A rotation that cannot decrypt yesterday's rows is an outage.

**The refresh race** deserves its own note. Intuit _rotates_ the refresh token on
every use and invalidates the previous one. Twenty workers noticing expiry
simultaneously means one succeeds and nineteen get `invalid_grant` — and if any
of those nineteen writes its failure state, a healthy connection is marked dead
and the tenant's pipeline stops until someone reconnects by hand. The fix is a
Postgres advisory lock keyed on the connection id, with the losers re-reading the
freshly stored token rather than refreshing again.

---

## 8. AI cost and safety

At 2M documents/day, extraction cost dominates unit economics. A careless
escalation policy is the difference between viable and not.

- **Cheapest capable model first.** Escalate to the second only below the trigger
  threshold.
- **Different model family for the second opinion.** Same-family models make
  correlated errors; diversity is the whole value.
- **`temperature: 0`** so a retry extracts identically — otherwise the consensus
  comparison measures sampling noise.
- **Structured outputs** (`strict: true`, `responseSchema`) so the model is
  constrained at decode time, not merely asked nicely.
- **One schema, translated.** Gemini's `responseSchema` is a JSON Schema subset;
  `toGeminiSchema()` derives it from the single source of truth rather than
  maintaining two that drift.
- **A failed second opinion does not fail the invoice.** It falls through to the
  confidence gate, which routes to a human — the safe default.

---

## 9. Observability

**Metrics cardinality is a design constraint.** `tenant_id` as a label with 1,000
tenants × 10 statuses is 50,000 series per metric. So `tenant_id` appears on
exactly one gauge — `tenant_pipeline_stalled` — where per-tenant alerting
genuinely matters and the series count is bounded by tenants _currently in a
failed state_. Per-tenant detail lives in Postgres, which is built for it.

**`duplicate_posts_prevented_total` is labelled by which guard fired.** A shift
in the distribution is an early signal that a guard has regressed, long before a
duplicate actually escapes.

**Deterministic log sampling.** Hashing the invoice id rather than using
`Math.random()` means a sampled invoice is logged at _every_ step — a trace you
can follow, instead of a scatter of disconnected lines.

**Graceful shutdown is ordered.** Kubernetes sends SIGTERM several times a day.
A worker killed mid-post leaves an invoice in `posting` with an unknown outcome —
exactly the expensive state. So: stop accepting work, drain in-flight, then close
I/O, with a hard-exit backstop shorter than `terminationGracePeriodSeconds`.

---

## 10. Reconciliation

Every guard reduces the probability of divergence; none makes it zero. Networks
partition, operators force-repost, users delete bills directly in QuickBooks.

Reconciliation **detects** rather than prevents, and in an accounting system
detection is what makes the pipeline auditable. It runs nightly against a read
replica, streams through server-side cursors, compares in integer minor units,
and records **every run including clean ones** — because "no breaks reported"
and "reconciliation did not run" must not look the same on a dashboard.

---

## Rejected alternatives

| Option                                    | Why not                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ORM (Prisma/TypeORM)                      | Fights RLS session context and partitioned DDL; generates queries that ignore the partition key                 |
| Kafka instead of Postgres outbox + BullMQ | Correct at far larger scale; at 25/sec it adds an operational tier without solving a problem we have            |
| `numeric` for money                       | Better than float, but invites accidental JS-number coercion. `bigint` minor units makes the mistake impossible |
| Auto-create missing QBO vendors           | Pollutes the tenant's chart of accounts permanently on a typo'd name, and is very hard to undo                  |
| Single AI model                           | Removes the only mechanical check on hallucinated amounts                                                       |
| Retry-by-default on unknown errors        | Risks duplicating an invisible side effect in a ledger                                                          |
| Per-process rate limiting                 | Cannot express a per-realm budget shared across the fleet                                                       |
