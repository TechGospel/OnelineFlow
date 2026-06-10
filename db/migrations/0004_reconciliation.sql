-- 0004_reconciliation.sql
-- Output of the nightly reconciler.
--
-- These are the only cross-tenant tables in the schema. They are intentionally
-- NOT under RLS by tenant, because their purpose is platform-wide operational
-- visibility; access is restricted at the role level instead (onelineflow_recon
-- and operators only, never the application role serving tenant requests).

BEGIN;

CREATE TABLE reconciliation_runs (
  id               bigserial PRIMARY KEY,
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz,
  tenant_count     integer NOT NULL DEFAULT 0,
  invoices_checked bigint  NOT NULL DEFAULT 0,
  break_count      integer NOT NULL DEFAULT 0,
  summary          text
);

-- Supports the "did reconciliation actually run last night?" alert. A missing
-- run and a clean run must be distinguishable — otherwise a silently dead cron
-- job looks exactly like a healthy system.
CREATE INDEX reconciliation_runs_started_idx ON reconciliation_runs (started_at DESC);

CREATE TABLE reconciliation_breaks (
  id            bigserial PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL,
  invoice_id    uuid,
  break_type    text NOT NULL CHECK (break_type IN
                  ('missing_in_qbo','duplicate_in_qbo','amount_mismatch','stalled','orphan_in_qbo')),
  detail        text NOT NULL,
  -- Money stays in integer minor units all the way to the report.
  local_minor   bigint,
  remote_minor  bigint,
  delta_minor   bigint,
  currency      char(3),
  -- Triage workflow. A break is not resolved by being looked at.
  acknowledged_at   timestamptz,
  acknowledged_by   uuid,
  resolution_note   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reconciliation_breaks_run_idx ON reconciliation_breaks (run_id);
CREATE INDEX reconciliation_breaks_tenant_idx ON reconciliation_breaks (tenant_id, created_at DESC);
-- The operator's working queue: unacknowledged breaks, worst type first.
CREATE INDEX reconciliation_breaks_open_idx ON reconciliation_breaks (break_type, created_at)
  WHERE acknowledged_at IS NULL;

-- Only the reconciler writes here; only operators read across tenants.
REVOKE ALL ON reconciliation_runs, reconciliation_breaks FROM onelineflow_app;
GRANT SELECT, INSERT, UPDATE ON reconciliation_runs, reconciliation_breaks TO onelineflow_recon;
GRANT USAGE, SELECT ON SEQUENCE reconciliation_runs_id_seq TO onelineflow_recon;
GRANT USAGE, SELECT ON SEQUENCE reconciliation_breaks_id_seq TO onelineflow_recon;

COMMIT;
