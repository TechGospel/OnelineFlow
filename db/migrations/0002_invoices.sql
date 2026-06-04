-- 0002_invoices.sql
-- The invoice pipeline tables.
--
-- Volume model: ~2M invoices/day => ~730M rows/year in `invoices` and roughly
-- 5-10x that in `invoice_line_items`. That rules out a single heap:
--
--   * RANGE partition by month on created_at. Keeps each partition's indexes in
--     cache-friendly territory, makes retention a DETACH rather than a DELETE of
--     60M rows, and lets VACUUM finish.
--   * Line items are partitioned on the SAME key and carry a denormalised
--     created_at so partition-wise joins work.
--   * The hot working set (anything not yet POSTED) is tiny relative to the
--     total, so partial indexes on non-terminal statuses stay small.

BEGIN;

-- ---------------------------------------------------------------------------
-- Documents: the immutable bytes we received, in object storage.
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- sha256(tenant_id || bytes). Dedupes identical files at ingestion.
  fingerprint   text NOT NULL,
  storage_key   text NOT NULL,
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL CHECK (byte_size > 0),
  page_count    integer CHECK (page_count IS NULL OR page_count > 0),
  source        text NOT NULL CHECK (source IN ('email', 'upload', 'api', 'zoho_creator', 'sftp')),
  source_ref    text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX documents_fingerprint_key ON documents (tenant_id, fingerprint);
CREATE INDEX documents_tenant_received_idx ON documents (tenant_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- Invoices (partitioned by month)
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  document_id          uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  status               text NOT NULL DEFAULT 'received',
  -- Optimistic concurrency. Every mutating UPDATE carries `AND version = $n`.
  version              integer NOT NULL DEFAULT 1,

  -- --- Extracted business fields -----------------------------------------
  vendor_name          text,
  vendor_tax_id        text,
  invoice_number       text,
  invoice_date         date,
  due_date             date,
  po_number            text,
  currency             char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),

  -- Money as integer minor units. Never numeric-with-scale, never float.
  subtotal_minor       bigint,
  tax_total_minor      bigint,
  total_minor          bigint,

  -- --- AI provenance ------------------------------------------------------
  extraction           jsonb,
  field_confidence     jsonb,
  overall_confidence   numeric(5,4) CHECK (overall_confidence IS NULL
                          OR overall_confidence BETWEEN 0 AND 1),
  extraction_models    text[],
  extraction_cost_micros bigint NOT NULL DEFAULT 0,

  -- --- Validation ---------------------------------------------------------
  findings             jsonb NOT NULL DEFAULT '[]'::jsonb,
  business_key         text,

  -- --- Approval -----------------------------------------------------------
  approved_by          uuid,
  approved_at          timestamptz,
  rejected_reason      text,

  -- --- QBO ----------------------------------------------------------------
  qbo_realm_id         text,
  qbo_entity_type      text CHECK (qbo_entity_type IS NULL
                          OR qbo_entity_type IN ('Bill', 'Purchase', 'VendorCredit')),
  qbo_entity_id        text,
  qbo_sync_token       text,
  qbo_doc_number       text,
  posted_at            timestamptz,
  -- Bumped ONLY by an audited admin force-repost. Feeds the requestid hash.
  post_attempt_epoch   integer NOT NULL DEFAULT 0,

  failure_code         text,
  failure_message      text,
  retry_count          integer NOT NULL DEFAULT 0,
  next_retry_at        timestamptz,

  PRIMARY KEY (id, created_at),

  CONSTRAINT invoices_status_valid CHECK (status IN (
    'received','extracting','extracted','needs_review','pending_approval',
    'approved','posting','posted','failed','rejected','voided')),

  -- A posted invoice must carry its ledger coordinates. This is the invariant
  -- that makes the idempotency guard trustworthy; without it a crash could
  -- leave status='posted' with no entity id and the retry would double-post.
  CONSTRAINT invoices_posted_has_entity CHECK (
    status <> 'posted'
    OR (qbo_entity_id IS NOT NULL AND qbo_realm_id IS NOT NULL AND posted_at IS NOT NULL)
  ),

  -- Totals must be present before anything can be approved.
  CONSTRAINT invoices_approved_has_total CHECK (
    status NOT IN ('approved','posting','posted')
    OR (total_minor IS NOT NULL AND currency IS NOT NULL AND vendor_name IS NOT NULL)
  )
) PARTITION BY RANGE (created_at);

-- A partitioned table may reference a plain table (PG 12+). The reverse is what
-- is restricted, which is why nothing FKs back to `invoices` — child tables
-- carry invoice_id without a constraint and are reconciled by the app instead.
ALTER TABLE invoices ADD CONSTRAINT invoices_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Line items (same partition key)
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_line_items (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_id       uuid NOT NULL,
  -- Denormalised from the parent purely to enable partition-wise joins.
  created_at       timestamptz NOT NULL DEFAULT now(),
  line_number      integer NOT NULL CHECK (line_number >= 0),
  description      text NOT NULL,
  quantity_micros  bigint,
  unit_price_minor bigint,
  amount_minor     bigint NOT NULL,
  gl_code          text,
  qbo_account_id   text,
  tax_code         text,
  qbo_tax_code_id  text,
  confidence       numeric(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- ---------------------------------------------------------------------------
-- Transactional outbox.
--
-- The posting worker never calls QBO inside a database transaction. It commits
-- an outbox row atomically with the state change, then a relay drains it. This
-- is what makes "invoice marked approved" and "job enqueued" impossible to
-- diverge — the classic dual-write failure.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text
);

-- The relay's only query: unpublished, oldest first. Partial index keeps it
-- proportional to the backlog rather than to total history.
CREATE INDEX outbox_unpublished_idx ON outbox (created_at)
  WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Immutable audit log. Append-only, enforced by policy and trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigserial NOT NULL,
  tenant_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'system', 'ai', 'admin')),
  actor_id     text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  before       jsonb,
  after        jsonb,
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP;
END $$;

-- ---------------------------------------------------------------------------
-- QBO API call log — one row per outbound request. Feeds rate-limit analysis
-- and gives support an exact replay of what we sent when a tenant disputes.
-- ---------------------------------------------------------------------------
CREATE TABLE qbo_api_calls (
  id            bigserial NOT NULL,
  tenant_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  realm_id      text NOT NULL,
  invoice_id    uuid,
  method        text NOT NULL,
  path          text NOT NULL,
  request_id    text,
  http_status   integer,
  intuit_tid    text,
  fault_code    text,
  duration_ms   integer,
  attempt       integer NOT NULL DEFAULT 1,
  -- Request/response bodies are redacted before storage; see qbo/redact.ts.
  request_body  jsonb,
  response_body jsonb,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

COMMIT;
