-- =============================================================================
-- 0800  A configuration, the way a technician fills one in
-- =============================================================================
--
-- A device page in the reference product is five sections: what it is, how
-- it was bought, where it lives and who looks after it, how it is reached,
-- and its interfaces. 0060's device table had most of the first four and
-- none of the fifth. This adds the columns the sections need and a table for
-- the interfaces, and nothing is removed or renamed: every reader of device
-- keeps working.
--
-- INTERFACES ARE ROWS, NOT A JSON COLUMN. Each has an address, a MAC, a port
-- and a device it is connected to, and "which switch port is this NAS on"
-- is a question somebody will ask of the data, which a jsonb column answers
-- badly. The primary interface writes device.primary_ip and primary_mac by
-- trigger, so the list column and the search index read one place.
-- =============================================================================

ALTER TABLE device
  ADD COLUMN IF NOT EXISTS purchased_by      text,
  ADD COLUMN IF NOT EXISTS installed_at      date,
  ADD COLUMN IF NOT EXISTS installed_by      text,
  ADD COLUMN IF NOT EXISTS physical_position text,
  -- Who looks after it. A contact of the same client; set NULL if they leave.
  ADD COLUMN IF NOT EXISTS contact_id        uuid,
  ADD COLUMN IF NOT EXISTS primary_ip        inet,
  ADD COLUMN IF NOT EXISTS default_gateway   inet,
  ADD COLUMN IF NOT EXISTS platform          text,
  ADD COLUMN IF NOT EXISTS os_notes          text;

-- SET NULL names its column: a bare composite SET NULL would null tenant_id
-- too, which is the defect db/tests/security.sql §41(g) exists to catch.
ALTER TABLE device
  ADD CONSTRAINT device_contact_fk FOREIGN KEY (contact_id, tenant_id)
    REFERENCES contact (id, tenant_id) ON DELETE SET NULL (contact_id);

CREATE INDEX IF NOT EXISTS device_primary_ip_idx ON device (tenant_id, primary_ip)
  WHERE primary_ip IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Interfaces.
-- -----------------------------------------------------------------------------
CREATE TABLE device_interface (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  organization_id      uuid NOT NULL,
  device_id            uuid NOT NULL,
  name                 text,
  ip_address           inet,
  mac_address          macaddr,
  port                 text,
  is_primary           boolean NOT NULL DEFAULT false,
  notes                text,
  -- The switch, firewall or network at the other end.
  connected_to_node_id uuid,
  position             smallint NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_interface_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT device_interface_device_fk FOREIGN KEY (device_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT device_interface_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT device_interface_connected_fk FOREIGN KEY (connected_to_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL (connected_to_node_id),
  CONSTRAINT device_interface_something CHECK (
    name IS NOT NULL OR ip_address IS NOT NULL OR mac_address IS NOT NULL
  ),
  CONSTRAINT device_interface_not_self CHECK (connected_to_node_id IS NULL OR connected_to_node_id <> device_id)
);
CREATE INDEX device_interface_device_idx ON device_interface (tenant_id, device_id);
CREATE INDEX device_interface_ip_idx ON device_interface (tenant_id, ip_address) WHERE ip_address IS NOT NULL;
CREATE UNIQUE INDEX device_interface_one_primary ON device_interface (device_id) WHERE is_primary;

COMMENT ON TABLE device_interface IS
  'A device''s network interfaces. The primary one is projected into '
  'device.primary_ip and primary_mac by helm.sync_device_primary_interface().';

-- The organisation comes from the device's node; nobody passes it.
CREATE OR REPLACE FUNCTION helm.device_interface_bind_organization() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  SELECT n.organization_id INTO NEW.organization_id
  FROM asset_node n WHERE n.id = NEW.device_id AND n.tenant_id = NEW.tenant_id;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'helm: no such device' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER device_interface_bind_organization
  BEFORE INSERT OR UPDATE OF device_id ON device_interface
  FOR EACH ROW EXECUTE FUNCTION helm.device_interface_bind_organization();

-- The primary interface's address and MAC, on the device.
CREATE OR REPLACE FUNCTION helm.sync_device_primary_interface() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_device uuid := coalesce(NEW.device_id, OLD.device_id);
  v_ip     inet;
  v_mac    macaddr;
BEGIN
  SELECT i.ip_address, i.mac_address INTO v_ip, v_mac
  FROM device_interface i WHERE i.device_id = v_device
  ORDER BY i.is_primary DESC, i.position, i.created_at LIMIT 1;
  -- Only when an interface says so: a device with none keeps what was typed.
  IF FOUND THEN
    UPDATE device SET
      primary_ip  = coalesce(v_ip, primary_ip),
      primary_mac = coalesce(v_mac, primary_mac)
    WHERE id = v_device;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER device_interface_sync AFTER INSERT OR UPDATE OR DELETE ON device_interface
  FOR EACH ROW EXECUTE FUNCTION helm.sync_device_primary_interface();

-- A connection is a relationship, and the graph should know it. An interface
-- that names a node draws a link (0050's asset_link, relation connects_to),
-- so the Dependencies card and the impact query see "connects to the core
-- switch" without a second entry. Idempotent: one link per pair, and a link
-- somebody drew by hand is left as it is.
CREATE OR REPLACE FUNCTION helm.device_interface_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.connected_to_node_id IS NOT NULL THEN
    INSERT INTO asset_link (tenant_id, source_node_id, target_node_id, relation, note)
    SELECT NEW.tenant_id, NEW.device_id, NEW.connected_to_node_id, 'connects_to',
           'interface ' || coalesce(NEW.name, host(NEW.ip_address), NEW.mac_address::text)
    WHERE NOT EXISTS (
      SELECT 1 FROM asset_link l
      WHERE l.source_node_id = NEW.device_id AND l.target_node_id = NEW.connected_to_node_id
        AND l.relation = 'connects_to'
    );
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER device_interface_link AFTER INSERT OR UPDATE OF connected_to_node_id ON device_interface
  FOR EACH ROW EXECUTE FUNCTION helm.device_interface_link();

-- -----------------------------------------------------------------------------
-- RLS and grants: as the device.
-- -----------------------------------------------------------------------------
SELECT helm.apply_tenant_rls('device_interface', true, 40, NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON device_interface TO helm_app;
GRANT SELECT ON device_interface TO helm_auditor;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'device_interface') THEN
    RAISE EXCEPTION '0800: device_interface has no RLS policy';
  END IF;
END $$;
