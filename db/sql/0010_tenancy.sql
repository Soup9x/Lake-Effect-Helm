-- =============================================================================
-- 0010_tenancy.sql — tenant / organization / site / contact
--
-- Hierarchy:  tenant (the MSP)  ->  organization (a client)  ->  site (a location)
--
-- The MSP itself is modelled as an organization inside its own tenant, flagged
-- is_msp_internal. That keeps organization_id NOT NULL everywhere downstream —
-- there is no "internal record with no client" special case to forget about in
-- an RLS policy, which is exactly the kind of hole nullable scoping columns
-- create.
--
-- Every scoping table carries UNIQUE (id, tenant_id). Child tables then declare
-- composite foreign keys against that pair, so a row can never reference a
-- parent belonging to a different tenant. This is structural tenant integrity:
-- it holds even if every RLS policy in 0200 were dropped.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'archived');

CREATE TYPE organization_status AS ENUM (
  'prospect', 'onboarding', 'active', 'co_managed', 'offboarding', 'former'
);

-- -----------------------------------------------------------------------------
-- tenant — the MSP root account. One row per MSP served by this deployment.
-- -----------------------------------------------------------------------------
CREATE TABLE tenant (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               citext NOT NULL UNIQUE,
  name               text NOT NULL,
  status             tenant_status NOT NULL DEFAULT 'active',
  primary_domain     citext,
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tenant_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT tenant_settings_object CHECK (jsonb_typeof(settings) = 'object')
);
COMMENT ON TABLE tenant IS 'MSP root account. Top of the isolation hierarchy.';

-- -----------------------------------------------------------------------------
-- organization — a client of the MSP (or the MSP itself).
-- -----------------------------------------------------------------------------
CREATE TABLE organization (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  slug                  citext NOT NULL,
  name                  text NOT NULL,
  legal_name            text,
  status                organization_status NOT NULL DEFAULT 'active',
  is_msp_internal       boolean NOT NULL DEFAULT false,

  industry              text,
  employee_count        integer,
  timezone              text NOT NULL DEFAULT 'America/New_York',
  website               text,
  logo_url              text,

  -- Free-text the technician sees first when they open the client. Deliberately
  -- called "quick notes" and deliberately NOT a secret store — a CHECK in 0200
  -- is not possible here, so the application refuses to persist anything the
  -- secret detector flags.
  quick_notes           text,

  account_manager_id    uuid,   -- -> app_user(id), wired in 0020
  primary_contact_id    uuid,   -- -> contact(id), wired below (circular FK)

  -- PSA / RMM correlation keys, populated by the integrations engine.
  psa_company_id        text,
  rmm_organization_id   text,

  onboarded_at          timestamptz,
  offboarded_at         timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  deleted_at            timestamptz,

  CONSTRAINT organization_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT organization_slug_uk   UNIQUE (tenant_id, slug),
  CONSTRAINT organization_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT organization_employee_count_sane CHECK (employee_count IS NULL OR employee_count >= 0)
);

-- At most one internal organization per tenant.
CREATE UNIQUE INDEX organization_one_internal_per_tenant
  ON organization (tenant_id) WHERE is_msp_internal;

CREATE INDEX organization_tenant_status_idx ON organization (tenant_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX organization_name_trgm_idx ON organization USING gin (name gin_trgm_ops);
CREATE INDEX organization_psa_company_idx ON organization (tenant_id, psa_company_id)
  WHERE psa_company_id IS NOT NULL;

COMMENT ON COLUMN organization.is_msp_internal IS
  'Marks the tenant''s own organization. Lets internal documentation live in the '
  'same scoping model as client documentation instead of a nullable special case.';

-- -----------------------------------------------------------------------------
-- site — a physical or logical location belonging to an organization.
--
-- Note that site is intentionally NOT an asset_node (see 0040). Sites are a
-- *scoping dimension*, like organizations; making them graph nodes would create
-- a circular foreign key with asset_node.site_id for no modelling gain.
-- -----------------------------------------------------------------------------
CREATE TABLE site (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  organization_id    uuid NOT NULL,

  name               text NOT NULL,
  code               text,                       -- short label, e.g. "BUF-HQ"
  is_primary         boolean NOT NULL DEFAULT false,

  address_line1      text,
  address_line2      text,
  city               text,
  region             text,
  postal_code        text,
  country            text NOT NULL DEFAULT 'US',
  latitude           numeric(9,6),
  longitude          numeric(9,6),
  timezone           text,

  main_phone         text,
  after_hours_phone  text,
  access_notes       text,                       -- alarm procedures, key holders
  physical_security  text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  deleted_at         timestamptz,

  CONSTRAINT site_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT site_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT site_code_uk UNIQUE (organization_id, code),
  CONSTRAINT site_latlon_paired CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE UNIQUE INDEX site_one_primary_per_org
  ON site (organization_id) WHERE is_primary AND deleted_at IS NULL;
CREATE INDEX site_tenant_org_idx ON site (tenant_id, organization_id)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- contact — a human at a client. May or may not have a Helm login.
-- -----------------------------------------------------------------------------
CREATE TABLE contact (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  organization_id    uuid NOT NULL,
  site_id            uuid,

  first_name         text NOT NULL,
  last_name          text NOT NULL,
  title              text,
  email              citext,
  phone              text,
  mobile             text,
  extension          text,

  is_primary         boolean NOT NULL DEFAULT false,
  is_technical       boolean NOT NULL DEFAULT false,
  is_billing         boolean NOT NULL DEFAULT false,
  is_emergency       boolean NOT NULL DEFAULT false,
  -- Whether this person is allowed to authorise changes / password resets.
  is_authorised      boolean NOT NULL DEFAULT false,

  notes              text,
  -- Populated when the contact also holds a Helm co-managed login.
  app_user_id        uuid,
  psa_contact_id     text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  deleted_at         timestamptz,

  CONSTRAINT contact_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT contact_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT contact_site_fk FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE SET NULL
);

CREATE INDEX contact_org_idx ON contact (tenant_id, organization_id)
  WHERE deleted_at IS NULL;
CREATE INDEX contact_email_idx ON contact (tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX contact_name_trgm_idx ON contact
  USING gin ((first_name || ' ' || last_name) gin_trgm_ops);

-- organization.primary_contact_id -> contact.id is a deliberate cycle
-- (org owns contacts; org names one of them primary). Nullable on the
-- organization side, so inserts order naturally: org, contact, then update.
ALTER TABLE organization
  ADD CONSTRAINT organization_primary_contact_fk
  FOREIGN KEY (primary_contact_id, tenant_id)
  REFERENCES contact (id, tenant_id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- updated_at maintenance, applied to every mutable table from here on.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_touch       BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
CREATE TRIGGER organization_touch BEFORE UPDATE ON organization
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
CREATE TRIGGER site_touch         BEFORE UPDATE ON site
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
CREATE TRIGGER contact_touch      BEFORE UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
