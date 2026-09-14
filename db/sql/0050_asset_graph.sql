-- =============================================================================
-- 0050_asset_graph.sql — asset_node supertype and the linking engine
--
-- The requirement is "link arbitrary assets to arbitrary assets". The tempting
-- implementation is a polymorphic (entity_type text, entity_id uuid) pair, and
-- it is a trap: no foreign keys, no cascade, and every delete leaves dangling
-- edges that surface months later as a dependency map quietly missing a hop.
--
-- Instead every documentable thing gets a row in asset_node, and the concrete
-- tables (device, ssl_certificate, ...) are subtypes keyed by the same id. Links
-- are then a plain table with two real foreign keys. Referential integrity,
-- cascades and tenant binding all come for free.
--
-- Edges are stored ONCE, in one direction, and read bi-directionally through
-- v_asset_edge. Storing both directions would double every write and create the
-- possibility of a half-deleted relationship.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE node_type AS ENUM (
  'device', 'network', 'ip_address', 'domain', 'ssl_certificate',
  'application', 'directory_service', 'contract', 'license',
  'isp_circuit', 'credential', 'sop', 'flexible_asset', 'vendor'
);

CREATE TYPE node_status AS ENUM (
  'planned', 'active', 'maintenance', 'retired', 'decommissioned'
);

CREATE TYPE link_relation AS ENUM (
  'depends_on', 'supports',
  'hosted_on', 'hosts',
  'connects_to',
  'member_of', 'contains',
  'secures', 'secured_by',
  'resolves_to', 'resolved_by',
  'authenticates_to', 'authenticates',
  'backs_up', 'backed_up_by',
  'licenses', 'licensed_by',
  'documents', 'documented_by',
  'replaces', 'replaced_by',
  'related_to'
);

CREATE TYPE link_origin AS ENUM ('manual', 'intrinsic', 'discovered', 'imported');

-- -----------------------------------------------------------------------------
-- asset_node — supertype for everything that can appear on the dependency map.
-- -----------------------------------------------------------------------------
CREATE TABLE asset_node (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  organization_id   uuid NOT NULL,
  site_id           uuid,

  node_type         node_type NOT NULL,
  name              text NOT NULL,
  description       text,
  status            node_status NOT NULL DEFAULT 'active',

  -- Free-form labels used for filtering and for the offboarding export.
  tags              text[] NOT NULL DEFAULT '{}',
  -- Marks documentation the client must never see even when co-managed
  -- (internal pricing notes, escalation politics, our own monitoring keys).
  is_internal_only  boolean NOT NULL DEFAULT false,

  external_ref      text,
  criticality       smallint NOT NULL DEFAULT 3,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  archived_at       timestamptz,

  -- Composite keys the subtype tables hang off.
  CONSTRAINT asset_node_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT asset_node_type_uk   UNIQUE (id, node_type),
  CONSTRAINT asset_node_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT asset_node_site_fk FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT asset_node_criticality_range CHECK (criticality BETWEEN 1 AND 5)
);

CREATE INDEX asset_node_org_type_idx ON asset_node (tenant_id, organization_id, node_type)
  WHERE archived_at IS NULL;
CREATE INDEX asset_node_site_idx ON asset_node (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX asset_node_name_trgm_idx ON asset_node USING gin (name gin_trgm_ops);
CREATE INDEX asset_node_tags_idx ON asset_node USING gin (tags);
CREATE INDEX asset_node_external_ref_idx ON asset_node (tenant_id, external_ref)
  WHERE external_ref IS NOT NULL;

COMMENT ON TABLE asset_node IS
  'Supertype for every documentable object. Concrete asset tables reference it '
  'by (id, tenant_id) and (id, node_type), which makes cross-tenant and '
  'wrong-subtype references structurally impossible rather than merely unlikely.';
COMMENT ON COLUMN asset_node.criticality IS
  '1 = cosmetic, 5 = business stops. Drives alert severity and export ordering.';

-- Subtype tables all declare this shape; keeping it in one comment rather than
-- repeating the reasoning fourteen times:
--
--   id        uuid PRIMARY KEY
--   tenant_id uuid NOT NULL
--   node_type node_type NOT NULL DEFAULT '<type>' CHECK (node_type = '<type>')
--   FOREIGN KEY (id, tenant_id) REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE
--   FOREIGN KEY (id, node_type) REFERENCES asset_node (id, node_type) ON DELETE CASCADE
--
-- The first FK pins the subtype row to its supertype *and* to the same tenant.
-- The second makes it impossible to attach a `device` row to a node declared as
-- an `ssl_certificate`.

-- -----------------------------------------------------------------------------
-- asset_link — explicit, human- or integration-asserted relationships.
-- -----------------------------------------------------------------------------
CREATE TABLE asset_link (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  source_node_id  uuid NOT NULL,
  target_node_id  uuid NOT NULL,
  relation        link_relation NOT NULL,
  origin          link_origin NOT NULL DEFAULT 'manual',

  note            text,
  -- How confident an automated discovery is. Manual links are 100.
  confidence      smallint NOT NULL DEFAULT 100,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT asset_link_source_fk FOREIGN KEY (source_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT asset_link_target_fk FOREIGN KEY (target_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT asset_link_no_self CHECK (source_node_id <> target_node_id),
  CONSTRAINT asset_link_uk UNIQUE (source_node_id, target_node_id, relation),
  CONSTRAINT asset_link_confidence_range CHECK (confidence BETWEEN 1 AND 100)
);

CREATE INDEX asset_link_source_idx ON asset_link (source_node_id, relation);
CREATE INDEX asset_link_target_idx ON asset_link (target_node_id, relation);
CREATE INDEX asset_link_tenant_idx ON asset_link (tenant_id);

-- -----------------------------------------------------------------------------
-- Relation inversion.
--
-- Symmetric relations invert to themselves. Everything else has a named
-- opposite so the reverse traversal reads naturally: a firewall that `secures`
-- a network shows up on the network as `secured_by`, not as a backwards arrow
-- the technician has to mentally flip at 2am.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.inverse_relation(p_relation link_relation)
  RETURNS link_relation
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  -- public must stay on the path: the body names the link_relation type, and a
  -- function-local search_path is applied when the body is parsed.
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT CASE p_relation
    WHEN 'depends_on'       THEN 'supports'
    WHEN 'supports'         THEN 'depends_on'
    WHEN 'hosted_on'        THEN 'hosts'
    WHEN 'hosts'            THEN 'hosted_on'
    WHEN 'member_of'        THEN 'contains'
    WHEN 'contains'         THEN 'member_of'
    WHEN 'secures'          THEN 'secured_by'
    WHEN 'secured_by'       THEN 'secures'
    WHEN 'resolves_to'      THEN 'resolved_by'
    WHEN 'resolved_by'      THEN 'resolves_to'
    WHEN 'authenticates_to' THEN 'authenticates'
    WHEN 'authenticates'    THEN 'authenticates_to'
    WHEN 'backs_up'         THEN 'backed_up_by'
    WHEN 'backed_up_by'     THEN 'backs_up'
    WHEN 'licenses'         THEN 'licensed_by'
    WHEN 'licensed_by'      THEN 'licenses'
    WHEN 'documents'        THEN 'documented_by'
    WHEN 'documented_by'    THEN 'documents'
    WHEN 'replaces'         THEN 'replaced_by'
    WHEN 'replaced_by'      THEN 'replaces'
    WHEN 'connects_to'      THEN 'connects_to'
    WHEN 'related_to'       THEN 'related_to'
  END::link_relation;
$$;

-- Guard against an enum value being added later without an inverse. A NULL
-- inverse would silently drop reverse edges from the dependency map.
DO $inv$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(e.enumlabel, ', ')
    INTO v_missing
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'link_relation'
    AND helm.inverse_relation(e.enumlabel::link_relation) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: link_relation values without an inverse: %', v_missing;
  END IF;
END
$inv$;

CREATE TRIGGER asset_node_touch BEFORE UPDATE ON asset_node
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
CREATE TRIGGER asset_link_touch BEFORE UPDATE ON asset_link
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
