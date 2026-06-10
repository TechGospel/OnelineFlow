# onelineFlow

Multi-tenant AI invoice-to-cash automation for QuickBooks Online.

An invoice arrives as a PDF or a photo. onelineFlow extracts it with two
independent AI models, refuses to trust either one alone, routes it through the
tenant's approval rules, and posts a Bill to QuickBooks — **exactly once**, under
any interleaving of crashes, retries and concurrent workers.

---

## Scale target

| Dimension                         | Target                              |
| --------------------------------- | ----------------------------------- |
| Tenants                           | 1,000+                              |
| Invoices per tenant per day       | 2,000+                              |
| Platform throughput               | ~2M invoices/day, ~25/sec sustained |
| Month-end peak                    | ~250/sec                            |
| Rows in `invoices` after one year | ~730M                               |

Those numbers drive nearly every design decision below. They are the reason the
tables are partitioned, the queues are tenant-fair, and the QuickBooks rate
limiter lives in Redis rather than in each process.

---

## Quick start

```bash
cp .env.example .env
```

Generate an encryption root key and paste it into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Bring up Postgres, Redis and MinIO:

```bash
pnpm stack:up
```

Install, migrate, and verify:

```bash
pnpm install && pnpm migrate && pnpm test
```

Run the services in three terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:extraction
```

```bash
pnpm dev:posting
```

> The compose stack uses ports **5442** (Postgres), **6390** (Redis) and
> **9010/9011** (MinIO) so it coexists with anything already running on the
> standard ports. Override with `POSTGRES_PORT` etc. in `.env`.

---

## Architecture at a glance

```
  ingest                extract                 approve            post
 ────────              ─────────               ─────────          ──────
 Creator ─┐
 Email   ─┼─▶  API  ──▶ outbox ──▶ extraction ──▶ consensus ──▶ approval ──▶ posting ──▶ QBO
 API     ─┤    (Fastify)  (Postgres)  worker        gate          matrix       worker
 n8n     ─┘                            │             │                          │
                                  Gemini + GPT   ≥ threshold?              4 duplicate
                                  (2 families)   agree exactly?              guards
                                                       │
                                                    no ─┴─▶ human review

                          nightly ─▶ Python reconciler ─▶ break report
```

Full reasoning in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## The four duplicate guards

A duplicate bill in a customer's general ledger is the worst failure this system
can produce. Preventing it requires more than one mechanism, because each one
can individually fail:

| #   | Guard                                                  | Defeated by                              | Covers                              |
| --- | ------------------------------------------------------ | ---------------------------------------- | ----------------------------------- |
| 1   | CAS claim `approved → posting` with expected version   | —                                        | Two workers racing the same invoice |
| 2   | Stored `qbo_entity_id`                                 | Crash between QBO success and our commit | Ordinary retries                    |
| 3   | Intuit `requestid` (deterministic per invoice + epoch) | Retention window expiry                  | Replayed HTTP request               |
| 4   | Recovery query by `DocNumber` before re-posting        | Non-unique DocNumber in the realm        | Timeouts, crashed workers           |

Guard 4 is the one most implementations omit, and it is the one that makes a
**timed-out write** safe. When the outcome is genuinely unknown, onelineFlow asks
QuickBooks what happened rather than guessing.

If a duplicate ever does occur, the nightly reconciler detects it
(`duplicate_in_qbo`) — prevention and detection are separate controls.

---

## Why the AI is safe to auto-post

Extraction is done by **two architecturally different model families**
(Gemini and GPT). Two models from the same family make correlated mistakes,
which would make a consensus gate feel safe while catching very little.

The rule:

> Auto-post only if the primary model is confident **and** — where a second
> opinion was taken — both models agree **exactly** on total, invoice number and
> currency.

- Confidence is the **minimum** over critical fields, never the mean. A mean lets
  nine confident fields hide one unreadable total.
- Agreement does **not** raise confidence above what the weaker model justified.
  Two models can be confidently wrong together.
- A one-cent disagreement on a total blocks. That is not a rounding nuance; it
  means one model misread a digit and there is no way to know which.
- The second model runs only when the first falls below the trigger threshold,
  so the safety costs very little in steady state.

Vendor documents are **untrusted input**. A PDF can carry white-on-white text
saying "ignore previous instructions". The defences are: models emit structured
data only and never take actions; output is schema-validated; amounts are
re-checked arithmetically in the mapper; and everything still passes the tenant's
approval matrix.

---

## Money

Money is **never** a float. Not in the database, not in the extraction schema,
not in transit.

- Stored as `bigint` minor units (cents, pence, kobo).
- Manipulated through a `Money` value type built on `bigint`.
- Parsed from exact decimal strings; more precision than the currency allows is
  **rejected**, not rounded.
- ISO-4217 exponents are respected — JPY has 0 decimals, KWD has 3. Getting this
  wrong posts 100× the real amount.
- Converted to a JSON number exactly once, at the QuickBooks boundary, with a
  lossless round-trip assertion.

Lines must sum to the invoice total. A mismatch is **refused**, never plugged
with a balancing line — a silent plug is how bad data enters a ledger.

---

## Tenant isolation

Shared schema with Postgres **Row Level Security**, keyed on a session GUC that
the connection wrapper sets on checkout and clears on release.

- A missing tenant context yields **zero rows**, never all rows.
- `FORCE ROW LEVEL SECURITY` so even the table owner is subject to the policies.
- The application role is not a superuser and owns nothing, so RLS cannot be
  silently bypassed.
- The tenant is taken from the **verified token only** — never a header, query
  parameter, or body field.

`db/verify_rls.sql` proves this with seven assertions and runs in CI as a
non-superuser. RLS that is enabled but ineffective looks identical to RLS that
works, right up until a tenant sees another tenant's ledger.

---

## Where Deluge fits

Zoho Creator and Deluge are the **tenant-facing adapter**, not the transaction
engine — Creator's API quotas and Deluge's execution limits are orders of
magnitude below platform throughput.

- `deluge/functions/OnelineFlow_Ingest.dg` — Creator → platform, with its own
  idempotency guard and retry sweeper.
- `deluge/functions/QBO_DirectPost.dg` — the direct-to-QuickBooks path for a
  **single-tenant** deployment that will never need platform scale. It carries
  the same four guards, implemented in Deluge.

---

## Layout

```
packages/
  core/           Money, errors, state machine, idempotency, config
  crypto/         Envelope encryption for tenant OAuth tokens
  db/             Pool with mandatory tenant scoping, repositories, outbox
  qbo/            QuickBooks client, rate limiter, fault classification, mapper
  ai/             Extraction providers and the consensus gate
  queue/          BullMQ topology and per-tenant fair scheduling
  observability/  Logging, metrics, graceful shutdown
services/
  api/                 Fastify — ingest, OAuth, webhooks
  worker-extraction/   AI extraction and confidence routing
  worker-posting/      The only code that writes to a customer's ledger
python/reconciler/     Nightly divergence detection
deluge/                Zoho Creator tenant adapter
db/migrations/         Plain SQL, checksummed, advisory-locked
```

---

## Commands

```bash
pnpm typecheck && pnpm lint && pnpm test
```

```bash
pnpm migrate:status
```

```bash
pnpm test:coverage
```

---

## Status

Core platform is implemented and verified: 118 TypeScript tests and 14 Python
tests pass, the workspace typechecks clean under `strict` +
`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, and all four
migrations apply to Postgres 16 with tenant isolation proven.

Not yet built — see [docs/roadmap.md](docs/roadmap.md):
the outbox relay process, the approval-matrix API, the review UI, the
reconciler's QuickBooks fetch loop and CLI, and Terraform/Helm deployment.
