-- =============================================================================
-- 0060_core_assets.sql — concrete asset subtypes
--
-- Each table is a subtype of asset_node (see the shape comment in 0050).
-- Domain columns only: identity, naming, hierarchy and the fields a technician
-- actually needs at 2am. Anything site- or client-specific that does not
-- generalise belongs in a flexible asset, not in another nullable column here.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE device_type AS ENUM (
  'server', 'workstation', 'laptop', 'virtual_machine', 'hypervisor',
  'firewall', 'router', 'switch', 'access_point', 'nas', 'san',
  'printer', 'ups', 'camera', 'phone_system', 'iot', 'other'
);

CREATE TYPE network_kind AS ENUM ('vlan', 'subnet', 'wan', 'vpn', 'wifi', 'management');

CREATE TYPE ip_assignment AS ENUM ('static', 'dhcp', 'dhcp_reservation', 'virtual', 'floating');

CREATE TYPE directory_kind AS ENUM (
  'active_directory', 'entra_id', 'hybrid', 'ldap', 'google_workspace', 'okta'
);

CREATE TYPE certificate_issuance AS ENUM ('public_ca', 'internal_ca', 'self_signed', 'acme');

-- -----------------------------------------------------------------------------
-- vendor — suppliers, ISPs, CAs, software publishers. Tenant-level, referenced
-- by contracts, licences and circuits.
-- -----------------------------------------------------------------------------
CREATE TABLE vendor (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  node_type       node_type NOT NULL DEFAULT 'vendor',

  legal_name      text,
  support_phone   text,
  support_email   citext,
  support_url     text,
  support_hours   text,
  account_number  text,
  escalation_path text,

  CONSTRAINT vendor_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT vendor_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT vendor_node_type_pin CHECK (node_type = 'vendor'),
  CONSTRAINT vendor_tenant_uk UNIQUE (id, tenant_id)
);

-- -----------------------------------------------------------------------------
-- network — VLANs, subnets, WAN links, VPN tunnels, SSIDs.
-- -----------------------------------------------------------------------------
CREATE TABLE network (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  node_type         node_type NOT NULL DEFAULT 'network',

  kind              network_kind NOT NULL,
  cidr              cidr,
  vlan_id           integer,
  gateway           inet,
  dns_servers       inet[],
  dhcp_range_start  inet,
  dhcp_range_end    inet,
  dhcp_server_node_id uuid,
  ssid              text,
  purpose           text,
  is_guest          boolean NOT NULL DEFAULT false,

  CONSTRAINT network_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT network_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT network_node_type_pin CHECK (node_type = 'network'),
  CONSTRAINT network_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT network_dhcp_server_fk FOREIGN KEY (dhcp_server_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT network_vlan_range CHECK (vlan_id IS NULL OR vlan_id BETWEEN 1 AND 4094),
  CONSTRAINT network_gateway_in_cidr CHECK (
    gateway IS NULL OR cidr IS NULL OR gateway << cidr
  ),
  CONSTRAINT network_dhcp_range_ordered CHECK (
    dhcp_range_start IS NULL OR dhcp_range_end IS NULL OR dhcp_range_start <= dhcp_range_end
  )
);
CREATE INDEX network_cidr_idx ON network USING gist (cidr inet_ops) WHERE cidr IS NOT NULL;

-- -----------------------------------------------------------------------------
-- device — servers, workstations, and every piece of network hardware.
-- -----------------------------------------------------------------------------
CREATE TABLE device (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  node_type            node_type NOT NULL DEFAULT 'device',

  device_type          device_type NOT NULL,
  hostname             citext,
  fqdn                 citext,
  manufacturer         text,
  model                text,
  serial_number        text,
  asset_tag            text,

  operating_system     text,
  os_version           text,
  cpu                  text,
  memory_gb            numeric(8,2),
  storage_gb           numeric(10,2),

  primary_mac          macaddr,
  management_url       text,
  -- Which network the device's primary interface sits on. The graph view
  -- projects this as an intrinsic edge, so it does not need a manual link.
  primary_network_id   uuid,
  -- Hypervisor or physical host for a VM.
  parent_device_id     uuid,

  purchased_at         date,
  warranty_expires_at  date,
  end_of_life_at       date,
  last_seen_at         timestamptz,

  rmm_device_id        text,
  backup_policy        text,
  monitoring_enabled   boolean NOT NULL DEFAULT true,

  CONSTRAINT device_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT device_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT device_node_type_pin CHECK (node_type = 'device'),
  CONSTRAINT device_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT device_network_fk FOREIGN KEY (primary_network_id, tenant_id)
    REFERENCES network (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT device_parent_fk FOREIGN KEY (parent_device_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT device_not_own_parent CHECK (parent_device_id IS NULL OR parent_device_id <> id),
  CONSTRAINT device_memory_sane CHECK (memory_gb IS NULL OR memory_gb > 0),
  CONSTRAINT device_eol_after_purchase CHECK (
    end_of_life_at IS NULL OR purchased_at IS NULL OR end_of_life_at >= purchased_at
  )
);
CREATE INDEX device_hostname_idx ON device (tenant_id, hostname) WHERE hostname IS NOT NULL;
CREATE INDEX device_serial_idx ON device (tenant_id, serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX device_warranty_idx ON device (tenant_id, warranty_expires_at)
  WHERE warranty_expires_at IS NOT NULL;
CREATE INDEX device_rmm_idx ON device (tenant_id, rmm_device_id) WHERE rmm_device_id IS NOT NULL;
CREATE INDEX device_parent_idx ON device (parent_device_id) WHERE parent_device_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- ip_address — tracked addresses, public and private.
-- -----------------------------------------------------------------------------
CREATE TABLE ip_address (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  node_type          node_type NOT NULL DEFAULT 'ip_address',

  address            inet NOT NULL,
  assignment         ip_assignment NOT NULL DEFAULT 'static',
  is_public          boolean NOT NULL DEFAULT false,
  network_id         uuid,
  assigned_node_id   uuid,
  ptr_record         citext,
  purpose            text,

  CONSTRAINT ip_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ip_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT ip_node_type_pin CHECK (node_type = 'ip_address'),
  CONSTRAINT ip_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT ip_network_fk FOREIGN KEY (network_id, tenant_id)
    REFERENCES network (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT ip_assigned_fk FOREIGN KEY (assigned_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT ip_host_address CHECK (address = host(address)::inet)
);
-- One row per address per network. Public addresses (network_id NULL) are
-- unique per organisation instead; enforced by the partial index below.
CREATE UNIQUE INDEX ip_address_in_network_uk ON ip_address (network_id, address)
  WHERE network_id IS NOT NULL;
CREATE INDEX ip_address_lookup_idx ON ip_address (tenant_id, address);
CREATE INDEX ip_address_assigned_idx ON ip_address (assigned_node_id)
  WHERE assigned_node_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- domain — registered DNS domains.
-- -----------------------------------------------------------------------------
CREATE TABLE domain (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  node_type           node_type NOT NULL DEFAULT 'domain',

  domain_name         citext NOT NULL,
  registrar           text,
  registrar_vendor_id uuid,
  registered_at       date,
  expires_at          date,
  auto_renew          boolean NOT NULL DEFAULT false,
  nameservers         text[],
  dns_provider        text,
  -- Registrar transfer lock. Its absence during an offboarding dispute is how
  -- domains get stolen, so it is a first-class field.
  transfer_locked     boolean,
  whois_privacy       boolean,
  dnssec_enabled      boolean NOT NULL DEFAULT false,
  registrar_credential_id uuid,

  CONSTRAINT domain_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT domain_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT domain_node_type_pin CHECK (node_type = 'domain'),
  CONSTRAINT domain_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT domain_vendor_fk FOREIGN KEY (registrar_vendor_id, tenant_id)
    REFERENCES vendor (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT domain_name_shape CHECK (domain_name ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  CONSTRAINT domain_expiry_after_registration CHECK (
    expires_at IS NULL OR registered_at IS NULL OR expires_at > registered_at
  )
);
CREATE UNIQUE INDEX domain_name_uk ON domain (tenant_id, domain_name);
CREATE INDEX domain_expiry_idx ON domain (tenant_id, expires_at) WHERE expires_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- ssl_certificate
-- -----------------------------------------------------------------------------
CREATE TABLE ssl_certificate (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  node_type          node_type NOT NULL DEFAULT 'ssl_certificate',

  common_name        citext NOT NULL,
  subject_alt_names  citext[] NOT NULL DEFAULT '{}',
  issuer             text,
  issuance           certificate_issuance NOT NULL DEFAULT 'public_ca',
  serial_number      text,
  -- Lowercase hex SHA-256 of the DER certificate. Identity without storing the
  -- certificate body.
  fingerprint_sha256 text,
  key_algorithm      text,
  key_size           integer,

  not_before         timestamptz,
  not_after          timestamptz,
  auto_renew         boolean NOT NULL DEFAULT false,
  renewal_method     text,

  domain_id          uuid,
  installed_on_node_id uuid,
  private_key_secret_id uuid,

  CONSTRAINT ssl_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ssl_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT ssl_node_type_pin CHECK (node_type = 'ssl_certificate'),
  CONSTRAINT ssl_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT ssl_domain_fk FOREIGN KEY (domain_id, tenant_id)
    REFERENCES domain (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT ssl_installed_fk FOREIGN KEY (installed_on_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT ssl_private_key_fk FOREIGN KEY (private_key_secret_id, tenant_id)
    REFERENCES secret (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT ssl_validity_ordered CHECK (
    not_before IS NULL OR not_after IS NULL OR not_after > not_before
  ),
  CONSTRAINT ssl_fingerprint_shape CHECK (
    fingerprint_sha256 IS NULL OR fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  )
);
CREATE INDEX ssl_expiry_idx ON ssl_certificate (tenant_id, not_after) WHERE not_after IS NOT NULL;
CREATE INDEX ssl_common_name_idx ON ssl_certificate (tenant_id, common_name);
CREATE INDEX ssl_san_idx ON ssl_certificate USING gin (subject_alt_names);

-- -----------------------------------------------------------------------------
-- directory_service — AD forests/domains and Entra tenants.
-- -----------------------------------------------------------------------------
CREATE TABLE directory_service (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  node_type             node_type NOT NULL DEFAULT 'directory_service',

  kind                  directory_kind NOT NULL,
  domain_name           citext,
  netbios_name          text,
  forest_name           citext,
  functional_level      text,
  entra_tenant_id       uuid,
  entra_primary_domain  citext,

  sync_enabled          boolean NOT NULL DEFAULT false,
  sync_tool             text,
  sync_server_node_id   uuid,
  password_policy_notes text,
  -- FSMO role holders, as node ids, for the AD case.
  fsmo_roles            jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT directory_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT directory_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT directory_node_type_pin CHECK (node_type = 'directory_service'),
  CONSTRAINT directory_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT directory_sync_server_fk FOREIGN KEY (sync_server_node_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT directory_fsmo_object CHECK (jsonb_typeof(fsmo_roles) = 'object'),
  CONSTRAINT directory_entra_has_tenant CHECK (
    kind NOT IN ('entra_id', 'hybrid') OR entra_tenant_id IS NOT NULL
  )
);
CREATE INDEX directory_entra_idx ON directory_service (tenant_id, entra_tenant_id)
  WHERE entra_tenant_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- application — SaaS subscriptions and hosted line-of-business apps.
-- -----------------------------------------------------------------------------
CREATE TABLE application (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  node_type          node_type NOT NULL DEFAULT 'application',

  vendor_id          uuid,
  category           text,
  version            text,
  is_saas            boolean NOT NULL DEFAULT false,
  url                text,
  admin_url          text,
  hosted_on_node_id  uuid,
  database_node_id   uuid,

  authentication     text,               -- 'sso' | 'local' | 'ldap' | ...
  sso_directory_id   uuid,
  business_criticality smallint,
  data_classification  text,
  -- Recovery objectives, used by the DR export.
  rto_minutes        integer,
  rpo_minutes        integer,

  CONSTRAINT application_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT application_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT application_node_type_pin CHECK (node_type = 'application'),
  CONSTRAINT application_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT application_vendor_fk FOREIGN KEY (vendor_id, tenant_id)
    REFERENCES vendor (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT application_host_fk FOREIGN KEY (hosted_on_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT application_db_fk FOREIGN KEY (database_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT application_sso_fk FOREIGN KEY (sso_directory_id, tenant_id)
    REFERENCES directory_service (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT application_criticality_range CHECK (
    business_criticality IS NULL OR business_criticality BETWEEN 1 AND 5
  )
);

-- -----------------------------------------------------------------------------
-- isp_circuit — internet and WAN services.
-- -----------------------------------------------------------------------------
CREATE TABLE isp_circuit (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  node_type           node_type NOT NULL DEFAULT 'isp_circuit',

  vendor_id           uuid,
  circuit_id          text,
  service_type        text,               -- fiber | coax | dsl | lte | mpls
  download_mbps       integer,
  upload_mbps         integer,
  is_primary          boolean NOT NULL DEFAULT false,

  static_ip_block     cidr,
  handoff_device_node_id uuid,
  account_number      text,
  support_phone       text,
  contract_ends_at    date,
  monthly_cost        numeric(12,2),

  CONSTRAINT circuit_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT circuit_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT circuit_node_type_pin CHECK (node_type = 'isp_circuit'),
  CONSTRAINT circuit_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT circuit_vendor_fk FOREIGN KEY (vendor_id, tenant_id)
    REFERENCES vendor (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT circuit_handoff_fk FOREIGN KEY (handoff_device_node_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT circuit_speeds_sane CHECK (
    (download_mbps IS NULL OR download_mbps > 0) AND (upload_mbps IS NULL OR upload_mbps > 0)
  )
);

-- -----------------------------------------------------------------------------
-- contract and license
-- -----------------------------------------------------------------------------
CREATE TABLE contract (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  node_type          node_type NOT NULL DEFAULT 'contract',

  vendor_id          uuid,
  contract_number    text,
  contract_type      text,               -- msa | sla | nda | subscription | lease
  starts_at          date,
  ends_at            date,
  auto_renew         boolean NOT NULL DEFAULT false,
  notice_period_days integer,
  value              numeric(14,2),
  currency           char(3) NOT NULL DEFAULT 'USD',
  billing_cycle      text,
  signed_by_contact_id uuid,

  CONSTRAINT contract_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT contract_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT contract_node_type_pin CHECK (node_type = 'contract'),
  CONSTRAINT contract_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT contract_vendor_fk FOREIGN KEY (vendor_id, tenant_id)
    REFERENCES vendor (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT contract_contact_fk FOREIGN KEY (signed_by_contact_id, tenant_id)
    REFERENCES contact (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT contract_dates_ordered CHECK (
    ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at
  ),
  CONSTRAINT contract_notice_sane CHECK (
    notice_period_days IS NULL OR notice_period_days BETWEEN 0 AND 365
  )
);
CREATE INDEX contract_ends_idx ON contract (tenant_id, ends_at) WHERE ends_at IS NOT NULL;

CREATE TABLE license (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  node_type        node_type NOT NULL DEFAULT 'license',

  vendor_id        uuid,
  application_id   uuid,
  license_type     text,                 -- perpetual | subscription | oem | volume
  seats_purchased  integer,
  seats_used       integer,
  -- Product keys are secrets, not text columns.
  license_key_secret_id uuid,
  starts_at        date,
  expires_at       date,
  auto_renew       boolean NOT NULL DEFAULT false,
  cost_per_seat    numeric(12,2),

  CONSTRAINT license_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT license_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT license_node_type_pin CHECK (node_type = 'license'),
  CONSTRAINT license_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT license_vendor_fk FOREIGN KEY (vendor_id, tenant_id)
    REFERENCES vendor (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT license_application_fk FOREIGN KEY (application_id, tenant_id)
    REFERENCES application (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT license_key_secret_fk FOREIGN KEY (license_key_secret_id, tenant_id)
    REFERENCES secret (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT license_seats_sane CHECK (
    (seats_purchased IS NULL OR seats_purchased >= 0)
    AND (seats_used IS NULL OR seats_used >= 0)
  )
);
CREATE INDEX license_expiry_idx ON license (tenant_id, expires_at) WHERE expires_at IS NOT NULL;
