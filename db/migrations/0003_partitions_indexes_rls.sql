-- 0003_partitions_indexes_rls.sql
-- Partition management, indexes sized for the hot working set, and RLS.

BEGIN;

-- ---------------------------------------------------------------------------
-- Partition maintenance
--
-- Called by a scheduled job. Idempotent, so running it twice is harmless and a
-- missed run self-heals on the next tick. `months_ahead` defaults to 3 so a
-- failed scheduler has a full quarter of runway before inserts start failing —
-- the single most common way a partitioned system falls over at 00:00 on the 1st.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(
  p_table       text,
  p_months_back integer DEFAULT 1,
  p_months_ahead integer DEFAULT 3
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_created integer := 0;
  v_month   date;
  v_name    text;
  v_from    date;
  v_to      date;
BEGIN
  FOR i IN -p_months_back .. p_months_ahead LOOP
    v_month := date_trunc('month', now())::date + make_interval(months => i);
    v_from  := v_month;
    v_to    := (v_month + interval '1 month')::date;
    v_name  := format('%s_p%s', p_table, to_char(v_month, 'YYYYMM'));

    IF to_regclass(format('public.%I', v_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        v_name, p_table, v_from, v_to);
      v_created := v_created + 1;
    END IF;
  END LOOP;
  RETURN v_created;
END $$;

-- Detach (never DROP) an aged-out partition. Detaching is instantaneous and
-- keeps the data available for export before an operator removes it explicitly.
CREATE OR REPLACE FUNCTION detach_partitions_older_than(
  p_table text,
  p_keep_months integer
) RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  v_cutoff date := (date_trunc('month', now()) - make_interval(months => p_keep_months))::date;
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = p_table
      AND c.relname ~ '_p\d{6}$'
      AND to_date(right(c.relname, 6), 'YYYYMM') < v_cutoff
  LOOP
    EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', p_table, r.relname);
    RETURN NEXT r.relname;
  END LOOP;
END $$;

SELECT ensure_monthly_partitions('invoices', 1, 3);
SELECT ensure_monthly_partitions('invoice_line_items', 1, 3);
SELECT ensure_monthly_partitions('audit_log', 1, 3);
SELECT ensure_monthly_partitions('qbo_api_calls', 1, 3);

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Every index on a 730M-row table costs write throughput and disk, so each one
-- below is justified by a specific query the system actually runs. The partial
-- WHERE clauses matter enormously: 'posted' is ~99% of rows after a month, so an
-- index restricted to non-terminal statuses stays in the low millions.
-- ---------------------------------------------------------------------------

-- Tenant inbox / dashboard listing.
CREATE INDEX invoices_tenant_created_idx ON invoices (tenant_id, created_at DESC);

-- Worker claim query: "what is ready to post". Partial => small and hot.
CREATE INDEX invoices_workqueue_idx ON invoices (tenant_id, status, created_at)
  WHERE status IN ('received','extracting','extracted','needs_review',
                   'pending_approval','approved','posting');

-- Retry sweeper.
CREATE INDEX invoices_retry_idx ON invoices (next_retry_at)
  WHERE next_retry_at IS NOT NULL AND status IN ('failed','posting');

-- Reverse lookup from a QBO webhook: "which invoice is entity 1234?"
CREATE INDEX invoices_qbo_entity_idx ON invoices (tenant_id, qbo_realm_id, qbo_entity_id)
  WHERE qbo_entity_id IS NOT NULL;

-- Duplicate detection support and support-desk search.
CREATE INDEX invoices_business_key_idx ON invoices (tenant_id, business_key)
  WHERE business_key IS NOT NULL;
CREATE INDEX invoices_vendor_number_idx ON invoices (tenant_id, vendor_name, invoice_number);

CREATE INDEX invoice_line_items_invoice_idx ON invoice_line_items (invoice_id, line_number);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX qbo_api_calls_invoice_idx ON qbo_api_calls (invoice_id, created_at DESC)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX qbo_api_calls_realm_idx ON qbo_api_calls (realm_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Business-key uniqueness.
--
-- A UNIQUE index on a partitioned table must contain the partition key, which
-- would let the same invoice re-enter in a new month. So uniqueness lives in
-- this small, unpartitioned side table instead: an INSERT here is the atomic
-- claim that makes ingestion idempotent, and it is cheap to keep forever.
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_dedup_keys (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_key text NOT NULL,
  invoice_id   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, business_key)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices            ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_dedup_keys  ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox              ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_api_calls       ENABLE ROW LEVEL SECURITY;

ALTER TABLE documents           FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices            FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items  FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_dedup_keys  FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox              FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log           FORCE ROW LEVEL SECURITY;
ALTER TABLE qbo_api_calls       FORCE ROW LEVEL SECURITY;

CREATE POLICY documents_isolation ON documents
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

CREATE POLICY invoices_isolation ON invoices
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

CREATE POLICY invoice_line_items_isolation ON invoice_line_items
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

CREATE POLICY invoice_dedup_keys_isolation ON invoice_dedup_keys
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

CREATE POLICY outbox_isolation ON outbox
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

CREATE POLICY qbo_api_calls_isolation ON qbo_api_calls
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

-- Audit log: readable within the tenant, insertable, never updatable or
-- deletable by anyone including the bypass role.
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (tenant_id = app_current_tenant() OR app_is_bypass());
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------------------
-- Application roles.
--
-- `onelineflow_app` is deliberately not the owner of any table, so FORCE RLS is
-- inescapable for it. `onelineflow_recon` may set app.bypass_rls for
-- cross-tenant reporting and is granted read-only access.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onelineflow_app') THEN
    CREATE ROLE onelineflow_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onelineflow_recon') THEN
    CREATE ROLE onelineflow_recon NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO onelineflow_app, onelineflow_recon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onelineflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO onelineflow_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO onelineflow_recon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO onelineflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO onelineflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO onelineflow_recon;

COMMIT;
