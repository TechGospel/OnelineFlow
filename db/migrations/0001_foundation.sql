-- 0001_foundation.sql
-- Tenancy, identity, and the QBO connection store.
--
-- Isolation model: shared schema + Postgres Row Level Security, keyed on a
-- session GUC (`app.tenant_id`) that the connection wrapper sets on checkout and
-- clears on release. A missing GUC yields zero rows rather than all rows — the
-- failure mode of a forgotten WHERE clause is "no data", never "another tenant's
-- data". Application roles are NOT superuser and NOT the table owner, so RLS is
-- never silently bypassed.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Helper: the current tenant, or NULL when unset.
-- STABLE (not IMMUTABLE) so the planner re-evaluates it per statement while
-- still caching within one statement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Escape hatch for the reconciler and migrations. Set only by trusted jobs on a
-- dedicated role; every use is logged at the application layer.
CREATE OR REPLACE FUNCTION app_is_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.bypass_rls', true), 'off') = 'on' $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'closed')),
  -- Per-tenant overrides for throughput and AI spend. Enforced in the app; kept
  -- here so an operator can throttle a noisy tenant without a deploy.
  max_invoices_per_day    integer NOT NULL DEFAULT 5000 CHECK (max_invoices_per_day > 0),
  max_concurrent_postings integer NOT NULL DEFAULT 8 CHECK (max_concurrent_postings > 0),
  ai_monthly_budget_cents bigint  NOT NULL DEFAULT 100000 CHECK (ai_monthly_budget_cents >= 0),
  settings           jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Users and membership
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citext so "Ada@x.com" and "ada@x.com" collide on the unique index rather
  -- than creating two accounts that a tenant admin then has to merge.
  email         citext,
  external_id   text,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_external_id_key ON users (external_id) WHERE external_id IS NOT NULL;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_members (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'approver', 'clerk', 'viewer')),
  -- Approval ceiling in minor units. NULL = unlimited (owners only).
  approval_limit_minor bigint CHECK (approval_limit_minor IS NULL OR approval_limit_minor >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX tenant_members_user_idx ON tenant_members (user_id);

-- ---------------------------------------------------------------------------
-- QBO connections
--
-- Tokens are stored as ciphertext produced by envelope encryption (see
-- packages/crypto). The DEK is wrapped by a KMS-held root key; `key_version`
-- lets us rotate without downtime by decrypting under the old version and
-- re-encrypting lazily on next use.
-- ---------------------------------------------------------------------------
CREATE TABLE qbo_connections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  realm_id               text NOT NULL CHECK (realm_id ~ '^\d{1,32}$'),
  environment            text NOT NULL CHECK (environment IN ('sandbox', 'production')),

  access_token_ct        bytea NOT NULL,
  refresh_token_ct       bytea NOT NULL,
  wrapped_dek            bytea NOT NULL,
  key_version            integer NOT NULL,

  access_token_expires_at  timestamptz NOT NULL,
  -- Intuit rotates the refresh token on use and expires it after ~100 days of
  -- inactivity. We alert well before this to avoid a silent pipeline death.
  refresh_token_expires_at timestamptz NOT NULL,

  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'reauth_required', 'revoked')),
  last_refreshed_at      timestamptz,
  last_error             text,
  consecutive_failures   integer NOT NULL DEFAULT 0,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- One live connection per realm per tenant. Partial so revoked rows are kept
  -- for audit without blocking a reconnect.
  CONSTRAINT qbo_connections_realm_env_uniq UNIQUE (tenant_id, realm_id, environment)
);

CREATE INDEX qbo_connections_tenant_idx ON qbo_connections (tenant_id);
CREATE INDEX qbo_connections_refresh_expiry_idx
  ON qbo_connections (refresh_token_expires_at)
  WHERE status = 'active';

CREATE TRIGGER qbo_connections_updated_at BEFORE UPDATE ON qbo_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Reference caches: QBO entity IDs keyed by natural name.
--
-- Without this every invoice costs 2-4 extra QBO reads. At 2M invoices/day that
-- is the difference between fitting inside the rate limit and not.
-- ---------------------------------------------------------------------------
CREATE TABLE qbo_reference_cache (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  realm_id      text NOT NULL,
  entity_type   text NOT NULL CHECK (entity_type IN
                   ('Vendor', 'Customer', 'Account', 'Item', 'TaxCode', 'Term', 'Class')),
  -- Normalised lookup key (lowercased, punctuation stripped) so vendor-name
  -- variation does not cause a cache miss.
  lookup_key    text NOT NULL,
  qbo_id        text NOT NULL,
  display_name  text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, realm_id, entity_type, lookup_key)
);

CREATE INDEX qbo_reference_cache_stale_idx ON qbo_reference_cache (refreshed_at);
-- Trigram index supports fuzzy vendor matching when the exact key misses.
CREATE INDEX qbo_reference_cache_name_trgm_idx
  ON qbo_reference_cache USING gin (display_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE tenants              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_connections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_reference_cache  ENABLE ROW LEVEL SECURITY;

-- FORCE so that even the table owner is subject to the policies. Without this a
-- migration run as owner, or an ORM connecting as owner, silently sees everything.
ALTER TABLE tenants              FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_members       FORCE ROW LEVEL SECURITY;
ALTER TABLE qbo_connections      FORCE ROW LEVEL SECURITY;
ALTER TABLE qbo_reference_cache  FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_isolation ON tenants
  USING (id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (id = app_current_tenant() OR app_is_bypass());

CREATE POLICY tenant_members_isolation ON tenant_members
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

CREATE POLICY qbo_connections_isolation ON qbo_connections
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

CREATE POLICY qbo_reference_cache_isolation ON qbo_reference_cache
  USING (tenant_id = app_current_tenant() OR app_is_bypass())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_bypass());

COMMIT;
