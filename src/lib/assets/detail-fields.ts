/**
 * What each kind of asset records about itself, as fields a form can render
 * and a route can write.
 *
 * THE COLUMNS EXISTED, THE FORM DID NOT. 0060 gave a network its CIDR, gateway,
 * VLAN, DNS servers and DHCP range, a device its serial, model and warranty,
 * a circuit its bandwidth and static block — and the create form set only the
 * one mandatory field per kind while the Details card dumped every column,
 * defaults included, with no way to change any of them. This catalogue is the
 * one list both the Details card and the edit form read, so a field that can
 * be shown can be edited and a field that can be edited is shown under the
 * same name.
 *
 * `pg` is the cast the route applies. Postgres does the validating: an address
 * that is not an address, a gateway outside its subnet, a VLAN above 4094 and a
 * certificate that expires before it starts are all refused by the column
 * type or a CHECK, and src/lib/api/pg-errors.ts turns that into a 400 with the
 * constraint's own sentence. The route never re-implements those rules.
 *
 * NOT HERE, deliberately: foreign keys. vendor_id, hosted_on_node_id,
 * primary_network_id and their kind are relationships, and the Dependencies
 * card and the link routes are where relationships are made — a uuid typed
 * into a text box is how links go wrong. Secret references and the external
 * check bookkeeping (0670) are not here for the reasons the asset page gives.
 */
export type DetailFieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'select'
  | 'text_list'
  | 'inet_list';

export interface DetailField {
  /** The column, which is also the key in the request body. */
  key: string;
  label: string;
  kind: DetailFieldKind;
  /** The SQL type the value is cast to; an enum name for a select. */
  pg: string;
  /** NOT NULL in the schema: the form cannot clear it. */
  required?: boolean;
  options?: readonly string[];
  hint?: string;
  min?: number;
  max?: number;
  /** Shown in the form; written on save; never listed on the card. */
  hideOnCard?: boolean;
}

const text = (key: string, label: string, hint?: string): DetailField =>
  ({ key, label, kind: 'text', pg: 'text', ...(hint ? { hint } : {}) });
const citext = (key: string, label: string, hint?: string): DetailField =>
  ({ key, label, kind: 'text', pg: 'citext', ...(hint ? { hint } : {}) });
const textarea = (key: string, label: string): DetailField => ({ key, label, kind: 'textarea', pg: 'text' });
const bool = (key: string, label: string, required = true): DetailField =>
  ({ key, label, kind: 'boolean', pg: 'boolean', required });
const date = (key: string, label: string): DetailField => ({ key, label, kind: 'date', pg: 'date' });
const datetime = (key: string, label: string): DetailField => ({ key, label, kind: 'datetime', pg: 'timestamptz' });
const integer = (key: string, label: string, min?: number, max?: number, hint?: string): DetailField => ({
  key, label, kind: 'number', pg: 'integer',
  ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(hint ? { hint } : {}),
});
const numeric = (key: string, label: string, hint?: string): DetailField =>
  ({ key, label, kind: 'number', pg: 'numeric', ...(hint ? { hint } : {}) });
const inet = (key: string, label: string, hint?: string): DetailField =>
  ({ key, label, kind: 'text', pg: 'inet', ...(hint ? { hint } : {}) });
const select = (key: string, label: string, pg: string, options: readonly string[], required = true): DetailField =>
  ({ key, label, kind: 'select', pg, options, required });

export const DEVICE_TYPES = [
  'server', 'workstation', 'laptop', 'virtual_machine', 'hypervisor',
  'firewall', 'router', 'switch', 'access_point', 'nas', 'san',
  'printer', 'ups', 'camera', 'phone_system', 'iot', 'other',
] as const;
export const NETWORK_KINDS = ['vlan', 'subnet', 'wan', 'vpn', 'wifi', 'management'] as const;
export const DIRECTORY_KINDS = [
  'active_directory', 'entra_id', 'hybrid', 'ldap', 'google_workspace', 'okta',
] as const;
export const CERTIFICATE_ISSUANCE = ['public_ca', 'internal_ca', 'self_signed', 'acme'] as const;
export const PLATFORMS = [
  'windows', 'windows_server', 'macos', 'linux', 'ios', 'android', 'chromeos',
  'network_os', 'embedded', 'other',
] as const;

export const DETAIL_FIELDS: Readonly<Record<string, readonly DetailField[]>> = {
  network: [
    select('kind', 'Kind', 'network_kind', NETWORK_KINDS),
    { key: 'cidr', label: 'Subnet (CIDR)', kind: 'text', pg: 'cidr', hint: 'e.g. 10.10.4.0/24 — the mask is shown from this' },
    inet('gateway', 'Gateway', 'Must sit inside the subnet'),
    integer('vlan_id', 'VLAN ID', 1, 4094),
    { key: 'dns_servers', label: 'DNS servers', kind: 'inet_list', pg: 'inet[]', hint: 'One per line, or comma separated' },
    inet('dhcp_range_start', 'DHCP range start'),
    inet('dhcp_range_end', 'DHCP range end'),
    text('ssid', 'SSID'),
    text('purpose', 'Purpose', 'e.g. Servers, Voice, Cameras'),
    bool('is_guest', 'Guest network'),
  ],
  device: [
    select('device_type', 'Device type', 'device_type', DEVICE_TYPES),
    citext('hostname', 'Hostname'),
    citext('fqdn', 'FQDN'),
    text('manufacturer', 'Manufacturer'),
    text('model', 'Model'),
    text('serial_number', 'Serial number'),
    text('asset_tag', 'Asset tag'),
    text('operating_system', 'Operating system'),
    text('os_version', 'OS version'),
    text('cpu', 'CPU'),
    numeric('memory_gb', 'Memory (GB)'),
    numeric('storage_gb', 'Storage (GB)'),
    { key: 'primary_mac', label: 'Primary MAC', kind: 'text', pg: 'macaddr', hint: 'aa:bb:cc:dd:ee:ff' },
    text('management_url', 'Management URL'),
    date('purchased_at', 'Purchased'),
    date('warranty_expires_at', 'Warranty expires'),
    date('end_of_life_at', 'End of life'),
    text('rmm_device_id', 'RMM device id'),
    text('backup_policy', 'Backup policy'),
    bool('monitoring_enabled', 'Monitored'),
    // 0800: the rest of the configuration form. contact_id is a relationship
    // and is written by the configuration routes, not from here.
    text('purchased_by', 'Purchased by'),
    date('installed_at', 'Installed'),
    text('installed_by', 'Installed by'),
    text('physical_position', 'Physical position', 'Rack 3, U12; under the desk in reception'),
    inet('primary_ip', 'Primary IP'),
    inet('default_gateway', 'Default gateway'),
    select('platform', 'Platform', 'text', PLATFORMS, false),
    textarea('os_notes', 'Operating system notes'),
  ],
  vendor: [
    text('legal_name', 'Legal name'),
    text('support_phone', 'Support phone'),
    citext('support_email', 'Support email'),
    text('support_url', 'Support URL'),
    text('support_hours', 'Support hours'),
    text('account_number', 'Account number'),
    textarea('escalation_path', 'Escalation path'),
  ],
  domain: [
    { ...citext('domain_name', 'Domain name'), required: true },
    text('registrar', 'Registrar'),
    date('registered_at', 'Registered'),
    date('expires_at', 'Expires'),
    bool('auto_renew', 'Auto-renew'),
    { key: 'nameservers', label: 'Nameservers', kind: 'text_list', pg: 'text[]', hint: 'One per line, or comma separated' },
    text('dns_provider', 'DNS provider'),
    bool('transfer_locked', 'Transfer locked', false),
    bool('whois_privacy', 'WHOIS privacy', false),
    bool('dnssec_enabled', 'DNSSEC'),
  ],
  ssl_certificate: [
    { ...citext('common_name', 'Common name'), required: true },
    // NOT NULL DEFAULT '{}' in 0060: an empty list is written as one, not as NULL.
    { key: 'subject_alt_names', label: 'Subject alternative names', kind: 'text_list', pg: 'citext[]', required: true, hint: 'One per line, or comma separated' },
    text('issuer', 'Issuer'),
    select('issuance', 'Issuance', 'certificate_issuance', CERTIFICATE_ISSUANCE),
    text('serial_number', 'Serial number'),
    text('fingerprint_sha256', 'SHA-256 fingerprint', '64 hex characters'),
    text('key_algorithm', 'Key algorithm'),
    integer('key_size', 'Key size (bits)', 1),
    datetime('not_before', 'Not before'),
    datetime('not_after', 'Not after'),
    bool('auto_renew', 'Auto-renew'),
    text('renewal_method', 'Renewal method'),
  ],
  directory_service: [
    select('kind', 'Kind', 'directory_kind', DIRECTORY_KINDS),
    citext('domain_name', 'Domain name'),
    text('netbios_name', 'NetBIOS name'),
    citext('forest_name', 'Forest name'),
    text('functional_level', 'Functional level'),
    { key: 'entra_tenant_id', label: 'Entra tenant id', kind: 'text', pg: 'uuid', hint: 'Required for Entra ID and hybrid' },
    citext('entra_primary_domain', 'Entra primary domain'),
    bool('sync_enabled', 'Directory sync'),
    text('sync_tool', 'Sync tool'),
    textarea('password_policy_notes', 'Password policy'),
  ],
  application: [
    text('category', 'Category'),
    text('version', 'Version'),
    bool('is_saas', 'SaaS'),
    text('url', 'URL'),
    text('admin_url', 'Admin URL'),
    text('authentication', 'Authentication', 'sso, local, ldap…'),
    integer('business_criticality', 'Business criticality', 1, 5),
    text('data_classification', 'Data classification'),
    integer('rto_minutes', 'RTO (minutes)', 0),
    integer('rpo_minutes', 'RPO (minutes)', 0),
  ],
  isp_circuit: [
    text('circuit_id', 'Circuit id'),
    text('service_type', 'Service type', 'fiber, coax, dsl, lte, mpls…'),
    integer('download_mbps', 'Download (Mbps)', 1),
    integer('upload_mbps', 'Upload (Mbps)', 1),
    bool('is_primary', 'Primary circuit'),
    { key: 'static_ip_block', label: 'Static IP block', kind: 'text', pg: 'cidr', hint: 'e.g. 203.0.113.8/29' },
    text('account_number', 'Account number'),
    text('support_phone', 'Support phone'),
    date('contract_ends_at', 'Contract ends'),
    numeric('monthly_cost', 'Monthly cost'),
  ],
  contract: [
    text('contract_number', 'Contract number'),
    text('contract_type', 'Contract type', 'msa, sla, nda, subscription, lease…'),
    date('starts_at', 'Starts'),
    date('ends_at', 'Ends'),
    bool('auto_renew', 'Auto-renew'),
    integer('notice_period_days', 'Notice period (days)', 0, 365),
    numeric('value', 'Value'),
    { ...text('currency', 'Currency', 'Three letters, e.g. USD'), pg: 'char(3)', required: true },
    text('billing_cycle', 'Billing cycle'),
  ],
  license: [
    text('license_type', 'Licence type', 'perpetual, subscription, oem, volume…'),
    integer('seats_purchased', 'Seats purchased', 0),
    integer('seats_used', 'Seats used', 0),
    date('starts_at', 'Starts'),
    date('expires_at', 'Expires'),
    bool('auto_renew', 'Auto-renew'),
    numeric('cost_per_seat', 'Cost per seat'),
  ],
};

/** The table a node type's details live in; the type is a database enum. */
export const DETAIL_TABLE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.keys(DETAIL_FIELDS).map((k) => [k, k]),
);

export function detailFieldsFor(nodeType: string): readonly DetailField[] {
  return DETAIL_FIELDS[nodeType] ?? [];
}

/** The dotted-quad mask an IPv4 prefix length means, for people who think in masks. */
export function subnetMaskOf(cidr: string | null | undefined): string | null {
  if (!cidr) return null;
  const slash = cidr.indexOf('/');
  if (slash < 0 || cidr.includes(':')) return null;
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 0xff).join('.');
}

/** Split a list field's text into values: one per line or comma separated. */
export function splitList(value: string): string[] {
  return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v !== '');
}
