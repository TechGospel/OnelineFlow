-- 0005_millisecond_partition_keys.sql
--
-- Fixes a bug that made every invoice state transition a no-op.
--
-- THE BUG
--
-- `now()` returns microsecond precision. A JavaScript Date holds only
-- milliseconds. `created_at` is part of the partition key, so every mutating
-- query carries it in the WHERE clause:
--
--     UPDATE invoices SET status = $1 ...
--      WHERE id = $2 AND created_at = $3 AND version = $4 AND status = $5
--
-- The application reads the row (Postgres 14:32:13.116528+00 → JS
-- 14:32:13.116), then passes that Date back. 14:32:13.116 <> 14:32:13.116528,
-- so the UPDATE matches ZERO rows and the repository raises ConflictError.
--
-- Nothing could ever leave 'received'. The whole pipeline was dead, and unit
-- tests could not see it because they never touch a real timestamp.
--
-- THE FIX
--
-- Store millisecond precision, so a JS Date is a lossless representation of the
-- stored value. Milliseconds are ample for an invoice creation timestamp, and
-- the round-trip safety is worth far more than the discarded microseconds.
--
-- Rejected alternatives:
--   * `date_trunc('milliseconds', created_at) = $3` in the WHERE clause — a
--     function on the partition column defeats partition pruning, which is the
--     entire reason created_at is in the predicate.
--   * Returning timestamptz as a string and threading strings through the app —
--     preserves precision but pushes parsing into every call site and makes the
--     partition key stringly typed.

BEGIN;

-- ---------------------------------------------------------------------------
-- Defaults. Inserts go through the partitioned parent, so setting it there
-- covers every partition, existing and future.
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now()),
  ALTER COLUMN updated_at SET DEFAULT date_trunc('milliseconds', now());

ALTER TABLE invoice_line_items
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());

ALTER TABLE audit_log
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());

ALTER TABLE qbo_api_calls
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());

ALTER TABLE documents
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now()),
  ALTER COLUMN received_at SET DEFAULT date_trunc('milliseconds', now());

-- ---------------------------------------------------------------------------
-- updated_at trigger. The DEFAULT does not apply on UPDATE, so the trigger has
-- to truncate too — otherwise `updated_at` drifts back to microseconds on the
-- first update and any future predicate on it hits the same trap.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := date_trunc('milliseconds', now());
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Existing rows still carry microseconds and would remain unmatchable. Updating
-- created_at on a partitioned table CANNOT move a row between partitions here
-- because truncation only ever moves a timestamp earlier by <1ms, and partition
-- boundaries are month starts — a row within 1ms of midnight on the 1st is the
-- only theoretical concern, and truncation of a value >= the boundary cannot
-- push it below the boundary unless it was already exactly the boundary.
--
-- Safe at current volume (pre-launch). At production scale this must be done in
-- batches per partition; see docs/roadmap.md.
-- ---------------------------------------------------------------------------
UPDATE invoices
   SET created_at = date_trunc('milliseconds', created_at)
 WHERE created_at <> date_trunc('milliseconds', created_at);

UPDATE invoice_line_items
   SET created_at = date_trunc('milliseconds', created_at)
 WHERE created_at <> date_trunc('milliseconds', created_at);

-- ---------------------------------------------------------------------------
-- Guard the invariant.
--
-- A future migration adding a column with a bare now() default would silently
-- reintroduce this. The constraint makes that fail loudly at write time.
-- NOT VALID so it applies to new rows without a full table scan on adoption.
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ADD CONSTRAINT invoices_created_at_millisecond_precision
  CHECK (created_at = date_trunc('milliseconds', created_at)) NOT VALID;

ALTER TABLE invoice_line_items
  ADD CONSTRAINT invoice_line_items_created_at_millisecond_precision
  CHECK (created_at = date_trunc('milliseconds', created_at)) NOT VALID;

COMMIT;
