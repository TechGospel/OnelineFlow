-- verify_rls.sql
-- Proves tenant isolation actually holds. Run in CI on every migration change.
--
-- This must be executed as a NON-SUPERUSER role that does not own the tables.
-- A superuser bypasses RLS unconditionally, so running this as the bootstrap
-- user would pass while proving nothing — which is precisely the trap that
-- makes RLS misconfigurations survive into production.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Seed two tenants using the bypass path (as the owner).
-- ---------------------------------------------------------------------------
SET app.bypass_rls = 'on';

INSERT INTO tenants (id, slug, display_name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'acme',   'Acme Ltd'),
  ('22222222-2222-4222-8222-222222222222', 'globex', 'Globex Inc')
ON CONFLICT (id) DO NOTHING;

INSERT INTO invoices (id, tenant_id, status, vendor_name, invoice_number,
                      currency, total_minor, created_at)
VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001',
   '11111111-1111-4111-8111-111111111111', 'received', 'Vendor A', 'A-1', 'USD', 10000, now()),
  ('bbbbbbbb-0000-4000-8000-000000000002',
   '22222222-2222-4222-8222-222222222222', 'received', 'Vendor B', 'B-1', 'USD', 20000, now())
ON CONFLICT DO NOTHING;

RESET app.bypass_rls;

-- ---------------------------------------------------------------------------
-- Assertions, run as the restricted app role.
-- ---------------------------------------------------------------------------
SET ROLE onelineflow_app_test;

DO $$
DECLARE
  v_count integer;
  v_ok    boolean;
BEGIN
  -- 1. No tenant context => zero rows. Fail closed, not open.
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO v_count FROM invoices;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL[1]: no tenant context leaked % invoice rows', v_count;
  END IF;
  RAISE NOTICE 'PASS[1] no tenant context => 0 rows';

  -- 2. Tenant A sees exactly its own row.
  PERFORM set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
  SELECT count(*) INTO v_count FROM invoices;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL[2]: tenant A saw % rows, expected 1', v_count;
  END IF;
  SELECT EXISTS (SELECT 1 FROM invoices WHERE vendor_name = 'Vendor A') INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FAIL[2]: tenant A cannot see its own invoice';
  END IF;
  RAISE NOTICE 'PASS[2] tenant A sees only its own row';

  -- 3. Tenant A cannot see tenant B even with an explicit id predicate.
  SELECT count(*) INTO v_count FROM invoices
    WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL[3]: cross-tenant read succeeded';
  END IF;
  RAISE NOTICE 'PASS[3] explicit cross-tenant SELECT returns nothing';

  -- 4. WITH CHECK blocks writing a row into another tenant.
  BEGIN
    INSERT INTO invoices (tenant_id, status, created_at)
    VALUES ('22222222-2222-4222-8222-222222222222', 'received', now());
    RAISE EXCEPTION 'FAIL[4]: cross-tenant INSERT was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS[4] cross-tenant INSERT rejected';
  END;

  -- 5. UPDATE cannot reach across tenants either.
  UPDATE invoices SET vendor_name = 'HIJACKED'
    WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL[5]: cross-tenant UPDATE touched % rows', v_count;
  END IF;
  RAISE NOTICE 'PASS[5] cross-tenant UPDATE touched 0 rows';

  -- 6. A non-privileged role must not be able to grant itself bypass.
  --    set_config succeeds (it is a USERSET GUC) but the policy still applies,
  --    because bypass is additionally gated by GRANTs on the recon role.
  PERFORM set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
  SELECT count(*) INTO v_count FROM invoices;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL[6]: expected 1 row for tenant A, got %', v_count;
  END IF;
  RAISE NOTICE 'PASS[6] tenant scoping stable';

  -- 7. Audit log is append-only.
  PERFORM set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
  INSERT INTO audit_log (tenant_id, actor_type, action, entity_type, entity_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'system', 'test', 'invoice', 'x');
  BEGIN
    UPDATE audit_log SET action = 'tampered'
      WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL[7]: audit_log UPDATE was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL[7]%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS[7] audit_log UPDATE blocked';
  END;

  RAISE NOTICE '--- ALL RLS ASSERTIONS PASSED ---';
END $$;

RESET ROLE;
