-- =============================================================================
-- 0570_site_topology.sql — a network diagram per site
--
-- WHAT THIS IS NOT. It is not the asset dependency graph. `asset_link` answers
-- "what breaks if this breaks" — reliance, impact, blast radius — and 0250
-- canonicalises its edges precisely because direction there is a modelling
-- statement rather than a fact about cabling. A topology answers a different
-- question: what is plugged into what, and where does it sit on the diagram.
--
-- The two disagree constantly and both are right. A firewall DEPENDS ON the ISP
-- circuit and is PHYSICALLY CONNECTED to a switch it does not depend on. Merging
-- them would force one of those to be a lie, so they stay separate tables with
-- separate semantics, and neither reads the other.
--
-- SCOPED TO ONE SITE, deliberately. A topology is a drawing of a building's
-- network. A client with four offices has four drawings, not one with four
-- disconnected islands, and "the whole client" has no useful layout.
--
-- -----------------------------------------------------------------------------
-- THE MISSING LINK, AND WHY THIS MIGRATION ADDS A COLUMN TO A TABLE THE BRIEF
-- DID NOT MENTION
--
-- Seeding a SITE's topology from UniFi requires knowing which UniFi mapping
-- feeds which site. That relationship did not exist. `unifi_site_mapping` binds
-- a controller site to an ORGANIZATION (`organization_id`), and its
-- `unifi_site_id` is the controller's own site string, not a Helm `site`. So a
-- client with three offices on one controller had no way to say which devices
-- belong to which office, and "a site with an active UniFi mapping" was not
-- expressible.
--
-- The smallest change that makes it expressible is a nullable `site_id` on the
-- mapping: an operator points a mapping at a site, and that site's topology
-- seeds from it. A mapping with no site_id seeds nothing, which is exactly the
-- specified behaviour for a site with no mapping — so the default is the safe
-- one and no existing deployment changes behaviour.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Vocabulary.
--
-- device_type exists for ICONS, not for truth. The asset record is where a
-- device's real classification lives; this is the shape somebody wants on a
-- diagram, which is why 'generic' is a legitimate answer and the list is short
-- enough to render without a lookup table.
-- -----------------------------------------------------------------------------
CREATE TYPE topology_device_type AS ENUM (
  'switch', 'router', 'firewall', 'server', 'access_point', 'generic'
);

-- Who put this row here. The whole non-destructive sync contract below is
-- written in terms of this column.
CREATE TYPE topology_source AS ENUM ('manual', 'unifi_sync');

-- -----------------------------------------------------------------------------
-- unifi_site_mapping gains the site it feeds.
--
-- Nullable and ON DELETE SET NULL: deleting a site must not take the controller
-- mapping with it. The mapping is integration configuration — an API key, a TLS
-- pin, a poll schedule — and re-establishing it because somebody renamed a
-- building would be a poor trade.
-- -----------------------------------------------------------------------------
ALTER TABLE unifi_site_mapping
  ADD COLUMN IF NOT EXISTS site_id uuid;

ALTER TABLE unifi_site_mapping
  DROP CONSTRAINT IF EXISTS unifi_mapping_site_fk;
ALTER TABLE unifi_site_mapping
  ADD CONSTRAINT unifi_mapping_site_fk
  FOREIGN KEY (site_id, tenant_id) REFERENCES site(id, tenant_id) ON DELETE SET NULL;

COMMENT ON COLUMN unifi_site_mapping.site_id IS
  'The Helm site whose topology this controller mapping seeds. NULL means the '
  'mapping feeds no topology, which is the default and the pre-0570 behaviour.';

CREATE INDEX IF NOT EXISTS unifi_mapping_site_idx
  ON unifi_site_mapping (site_id) WHERE site_id IS NOT NULL;

/*
 * A mapping and its site must belong to the same client.
 *
 * Not expressible as a CHECK — it spans two tables — and not safe to leave to
 * the application, because the consequence is a diagram of one client's network
 * hanging off another client's building. The FK above already pins the tenant;
 * this pins the organisation inside it.
 */
CREATE OR REPLACE FUNCTION helm.unifi_mapping_site_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_site_org uuid;
BEGIN
  IF NEW.site_id IS NULL THEN RETURN NEW; END IF;

  SELECT organization_id INTO v_site_org
  FROM site WHERE id = NEW.site_id AND tenant_id = NEW.tenant_id;

  IF v_site_org IS NULL THEN
    RAISE EXCEPTION 'helm: site % is not in this tenant', NEW.site_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_site_org <> NEW.organization_id THEN
    RAISE EXCEPTION
      'helm: site % belongs to a different client than this UniFi mapping',
      NEW.site_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS unifi_mapping_site_check ON unifi_site_mapping;
CREATE TRIGGER unifi_mapping_site_check
  BEFORE INSERT OR UPDATE OF site_id, organization_id ON unifi_site_mapping
  FOR EACH ROW EXECUTE FUNCTION helm.unifi_mapping_site_guard();

-- -----------------------------------------------------------------------------
-- topology_node — one box on the diagram.
--
-- WHY label/ip_address/subnet ARE PLAIN TEXT AND NOT `inet`.
--
-- They are what the diagram SAYS, not what the device IS. `asset_node` and
-- `network_assets` hold the authoritative record; a node on a drawing routinely
-- wants "10.0.20.0/24 — VLAN 20 (voice)" in the subnet slot, which is not a
-- cidr and should not have to be. Typing these as inet/cidr would turn a
-- legitimate annotation into a 500 from the driver, and would buy nothing: no
-- query here does subnet containment.
--
-- asset_node_id is nullable ON PURPOSE. An ISP handoff, a patch panel or a
-- label-only annotation has no asset record and never will, and refusing to
-- draw it would make the diagram lie by omission.
-- -----------------------------------------------------------------------------
CREATE TABLE topology_node (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id       uuid NOT NULL,

  -- The real asset, when there is one. Clicking the node opens it.
  asset_node_id uuid,

  label         text NOT NULL,
  ip_address    text,
  subnet        text,
  device_type   topology_device_type NOT NULL DEFAULT 'generic',

  -- NULL means "never placed". The canvas lays those out on first load and the
  -- drag that follows is what writes coordinates. Storing a synthetic default
  -- instead would make "the user positioned this" unanswerable.
  pos_x         double precision,
  pos_y         double precision,

  source        topology_source NOT NULL DEFAULT 'manual',

  /*
   * The sync's identity for this node, and the reason it can be re-run.
   *
   * Same blind index network_assets is keyed by (0430), so a device is matched
   * the way the rest of the integration matches it rather than by a name that
   * changes when somebody renames it on the controller.
   */
  mac_blind_index bytea,

  /*
   * USER CUSTOMISATION MARKERS.
   *
   * network_assets protects custom_name by keeping it in a column the poll
   * never writes. That works there because the user's name and the controller's
   * name are different fields. Here they are the SAME field — a node has one
   * label, whoever last decided it — so the protection has to be a marker
   * rather than a second column, and the upsert consults it.
   *
   * Set by the edit path, never by the sync. Once true, that field is the
   * user's and a poll does not get to have an opinion about it.
   */
  label_customised       boolean NOT NULL DEFAULT false,
  device_type_customised boolean NOT NULL DEFAULT false,
  ip_address_customised  boolean NOT NULL DEFAULT false,
  subnet_customised      boolean NOT NULL DEFAULT false,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT topology_node_site_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES site(id, tenant_id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: retiring an asset should not silently delete the box
  -- that shows where it was plugged in. The diagram keeps the shape; the link
  -- to the asset record goes.
  CONSTRAINT topology_node_asset_fk
    FOREIGN KEY (asset_node_id, tenant_id) REFERENCES asset_node(id, tenant_id) ON DELETE SET NULL,

  CONSTRAINT topology_node_label_present CHECK (length(btrim(label)) > 0),
  CONSTRAINT topology_node_label_len     CHECK (length(label) <= 120),
  CONSTRAINT topology_node_ip_len        CHECK (ip_address IS NULL OR length(ip_address) <= 64),
  CONSTRAINT topology_node_subnet_len    CHECK (subnet IS NULL OR length(subnet) <= 64),
  CONSTRAINT topology_node_mac_index_len CHECK (
    mac_blind_index IS NULL OR octet_length(mac_blind_index) = 32),
  -- A synced node without an identity could never be matched again, so the next
  -- poll would insert a duplicate. Unrepresentable is better than eventually
  -- noticed.
  CONSTRAINT topology_node_synced_has_identity CHECK (
    source <> 'unifi_sync' OR mac_blind_index IS NOT NULL),
  -- Both coordinates or neither; half a position is not a position.
  CONSTRAINT topology_node_position_complete CHECK (
    (pos_x IS NULL) = (pos_y IS NULL))
);

-- topology_link's endpoint FKs are composite, so this has to exist before that
-- table is created.
ALTER TABLE topology_node ADD CONSTRAINT topology_node_tenant_uk UNIQUE (id, tenant_id);

CREATE INDEX topology_node_site_idx ON topology_node (tenant_id, site_id);
CREATE INDEX topology_node_asset_idx
  ON topology_node (asset_node_id) WHERE asset_node_id IS NOT NULL;

-- One box per device per site. Partial, because manual nodes have no identity
-- and must not collide with each other on NULL.
CREATE UNIQUE INDEX topology_node_device_uk
  ON topology_node (tenant_id, site_id, mac_blind_index)
  WHERE mac_blind_index IS NOT NULL;

COMMENT ON TABLE topology_node IS
  'A box on a site network diagram. Distinct from asset_link: this is physical '
  'or logical connectivity, not reliance. Positions and user-edited fields are '
  'never overwritten by the UniFi sync.';

CREATE TRIGGER topology_node_touch BEFORE UPDATE ON topology_node
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- -----------------------------------------------------------------------------
-- topology_link — one line on the diagram.
--
-- Directed as stored (from → to, where "from" is the downstream device and "to"
-- is its uplink) because that is what the telemetry gives us, but rendered as a
-- plain line. Nothing reads the direction yet; keeping it costs a column and
-- throwing it away would mean re-deriving it from a poll that may no longer
-- report the device.
-- -----------------------------------------------------------------------------
CREATE TABLE topology_link (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  site_id      uuid NOT NULL,

  from_node_id uuid NOT NULL,
  to_node_id   uuid NOT NULL,

  -- Port or interface, when anything knows it. "Gi1/0/24", "WAN1".
  label        text,
  source       topology_source NOT NULL DEFAULT 'manual',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT topology_link_site_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES site(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT topology_link_from_fk
    FOREIGN KEY (from_node_id, tenant_id) REFERENCES topology_node(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT topology_link_to_fk
    FOREIGN KEY (to_node_id, tenant_id) REFERENCES topology_node(id, tenant_id) ON DELETE CASCADE,

  CONSTRAINT topology_link_not_self  CHECK (from_node_id <> to_node_id),
  CONSTRAINT topology_link_label_len CHECK (label IS NULL OR length(label) <= 80)
);

CREATE INDEX topology_link_site_idx ON topology_link (tenant_id, site_id);
CREATE INDEX topology_link_from_idx ON topology_link (from_node_id);
CREATE INDEX topology_link_to_idx   ON topology_link (to_node_id);

/*
 * One line between any two boxes, in either direction.
 *
 * least/greatest rather than a plain unique on (from, to): A→B and B→A are the
 * same cable, and storing both draws two lines on top of each other. This is
 * the one place topology borrows an idea from asset_link's canonicalisation,
 * and it borrows it as an index rather than as a rewrite — the stored direction
 * still means something, it just cannot be duplicated.
 */
CREATE UNIQUE INDEX topology_link_pair_uk
  ON topology_link (tenant_id, least(from_node_id, to_node_id), greatest(from_node_id, to_node_id));

COMMENT ON TABLE topology_link IS
  'A line on a site network diagram: physical or logical connectivity. NOT '
  'asset_link, which models reliance and impact.';

CREATE TRIGGER topology_link_touch BEFORE UPDATE ON topology_link
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

/*
 * A link's endpoints must be on the link's own site.
 *
 * The FKs pin the tenant; nothing yet pins the site, and a line between two
 * buildings is not a thing a diagram can render. Cross-table again, so again a
 * trigger rather than a CHECK.
 */
CREATE OR REPLACE FUNCTION helm.topology_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_mismatch integer;
BEGIN
  SELECT count(*) INTO v_mismatch
  FROM topology_node n
  WHERE n.id IN (NEW.from_node_id, NEW.to_node_id)
    AND (n.site_id <> NEW.site_id OR n.tenant_id <> NEW.tenant_id);

  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'helm: a topology link must join two nodes on its own site'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS topology_link_endpoints ON topology_link;
CREATE TRIGGER topology_link_endpoints
  BEFORE INSERT OR UPDATE OF from_node_id, to_node_id, site_id ON topology_link
  FOR EACH ROW EXECUTE FUNCTION helm.topology_link_guard();

-- -----------------------------------------------------------------------------
-- Row level security.
--
-- Scoped through `site`, using the existing parent-scoped builder. A topology
-- row is visible exactly when its site is, so the organisation scoping, the
-- tenant check and the client/MSP boundary are all inherited rather than
-- restated — and a future change to how sites are scoped cannot leave the
-- diagrams behind.
--
-- Write rank 40 (tier1), matching `site` and `asset_node`: drawing a network
-- diagram is ordinary client-data editing, not an administrative act. The route
-- layer additionally declares asset:write; see the migration's tail for why
-- both exist.
-- -----------------------------------------------------------------------------
SELECT helm.apply_child_rls('topology_node', 'site', 'site_id', 40);
SELECT helm.apply_child_rls('topology_link', 'site', 'site_id', 40);

GRANT SELECT, INSERT, UPDATE, DELETE ON topology_node TO helm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON topology_link TO helm_app;
GRANT SELECT ON topology_node TO helm_auditor;
GRANT SELECT ON topology_link TO helm_auditor;

-- =============================================================================
-- The sync contract
-- =============================================================================

/*
 * helm.upsert_topology_node — the whole non-destructive promise, in one place.
 *
 * SECURITY INVOKER, unlike helm.upsert_network_asset. That function is DEFINER
 * because it writes encrypted columns the request role has no business writing
 * directly. This one writes a label and two coordinates, and the sync identity
 * (system_sync, rank 80) already clears the rank-40 write policy — so ordinary
 * RLS governs it and the function holds no privilege of its own.
 *
 * WHAT A POLL MAY CHANGE, exhaustively: label, ip_address, subnet and
 * device_type, and each only while its *_customised marker is false. Everything
 * else in the row belongs to whoever drew the diagram.
 *
 * DELIBERATELY ABSENT from the update list, and this is the point of the
 * function: pos_x, pos_y, every *_customised marker, asset_node_id and source.
 * A sync run that moved a box somebody had positioned would make the feature
 * useless, and it is the kind of regression that only shows up on a customer's
 * diagram a week later.
 */
CREATE OR REPLACE FUNCTION helm.upsert_topology_node(
  p_site_id         uuid,
  p_mac_blind_index bytea,
  p_label           text,
  p_ip_address      text,
  p_subnet          text,
  p_device_type     topology_device_type,
  p_asset_node_id   uuid DEFAULT NULL
) RETURNS TABLE (node_id uuid, was_insert boolean)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_id     uuid;
  v_new    boolean;
BEGIN
  IF p_mac_blind_index IS NULL THEN
    RAISE EXCEPTION 'helm: a synced topology node needs a device identity'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO topology_node (
    tenant_id, site_id, asset_node_id, label, ip_address, subnet,
    device_type, source, mac_blind_index)
  VALUES (
    v_tenant, p_site_id, p_asset_node_id, p_label, p_ip_address, p_subnet,
    coalesce(p_device_type, 'generic'), 'unifi_sync', p_mac_blind_index)
  ON CONFLICT (tenant_id, site_id, mac_blind_index) WHERE mac_blind_index IS NOT NULL
  DO UPDATE SET
    label       = CASE WHEN topology_node.label_customised
                       THEN topology_node.label ELSE EXCLUDED.label END,
    ip_address  = CASE WHEN topology_node.ip_address_customised
                       THEN topology_node.ip_address ELSE EXCLUDED.ip_address END,
    subnet      = CASE WHEN topology_node.subnet_customised
                       THEN topology_node.subnet ELSE EXCLUDED.subnet END,
    device_type = CASE WHEN topology_node.device_type_customised
                       THEN topology_node.device_type ELSE EXCLUDED.device_type END,
    -- Only ever fills a gap. A node the user attached to an asset by hand keeps
    -- that attachment; a node that has none gains one when the poll can supply it.
    asset_node_id = coalesce(topology_node.asset_node_id, EXCLUDED.asset_node_id)
    -- ABSENT, and required to stay absent: pos_x, pos_y, source,
    -- label_customised, ip_address_customised, subnet_customised,
    -- device_type_customised. See the header.
  RETURNING id, (xmax = 0) INTO v_id, v_new;

  RETURN QUERY SELECT v_id, v_new;
END;
$$;

/*
 * helm.upsert_topology_link — idempotent, and quiet about duplicates.
 *
 * The pair index means a second poll reporting the same uplink is a no-op
 * rather than an error, and a link a user drew by hand between the same two
 * boxes is left exactly as they drew it, label and all. A poll does not get to
 * relabel somebody's line.
 */
CREATE OR REPLACE FUNCTION helm.upsert_topology_link(
  p_site_id uuid,
  p_from    uuid,
  p_to      uuid,
  p_label   text DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_id     uuid;
BEGIN
  IF p_from = p_to THEN RETURN NULL; END IF;

  SELECT id INTO v_id FROM topology_link
  WHERE tenant_id = v_tenant
    AND least(from_node_id, to_node_id) = least(p_from, p_to)
    AND greatest(from_node_id, to_node_id) = greatest(p_from, p_to);

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO topology_link (tenant_id, site_id, from_node_id, to_node_id, label, source)
  VALUES (v_tenant, p_site_id, p_from, p_to, p_label, 'unifi_sync')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION helm.upsert_topology_node(uuid, bytea, text, text, text, topology_device_type, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.upsert_topology_link(uuid, uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.upsert_topology_node(uuid, bytea, text, text, text, topology_device_type, uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.upsert_topology_link(uuid, uuid, uuid, text) TO helm_app;

-- =============================================================================
-- Assertions
--
-- The catalogue check in 0200 ran once, when 0200 ran. A table added in 0570 is
-- outside it, so 0570 asserts its own invariants — the same posture 0430 and
-- 0450 took, and the reason those tables are protected today.
-- =============================================================================
DO $assert$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('topology_node', 'topology_link')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: topology tables without forced RLS: %', v_missing;
  END IF;

  -- Four commands, both tables. A missing DELETE policy is the one that reads
  -- as working right up until somebody tries to remove a box.
  SELECT string_agg(t.relname || ':' || t.cmds::text, ', ') INTO v_missing
  FROM (
    SELECT c.relname, count(DISTINCT p.cmd) AS cmds
    FROM pg_class c
    LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
    WHERE c.relname IN ('topology_node', 'topology_link')
    GROUP BY c.relname
  ) t
  WHERE t.cmds <> 4;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: topology tables missing per-command policies: %', v_missing;
  END IF;

  /*
   * The load-bearing one. If a future edit adds pos_x to the upsert's SET list,
   * every synced diagram silently re-arranges itself on the next poll and
   * nobody finds out until a customer opens one. Assert it here, where the
   * mistake would be made.
   */
  IF pg_get_functiondef('helm.upsert_topology_node(uuid, bytea, text, text, text, topology_device_type, uuid)'::regprocedure)
     ~* '(SET|,)\s*pos_[xy]\s*=' THEN
    RAISE EXCEPTION
      'helm: upsert_topology_node assigns pos_x/pos_y — a sync must never move a node';
  END IF;

  IF pg_get_functiondef('helm.upsert_topology_node(uuid, bytea, text, text, text, topology_device_type, uuid)'::regprocedure)
     ~* '(SET|,)\s*[a-z_]*_customised\s*=' THEN
    RAISE EXCEPTION
      'helm: upsert_topology_node assigns a customisation marker — only a person may set one';
  END IF;
END
$assert$;
