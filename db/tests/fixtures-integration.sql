-- =============================================================================
-- db/tests/fixtures-integration.sql — tenancy, identity and topology only.
--
-- Deliberately does NOT create data keys or secrets. The integration suite
-- provisions real keys through TenantKeyService and writes real ciphertext
-- through SecretService, because the point is to exercise the actual encryption
-- path rather than to decrypt random bytes.
-- =============================================================================

\set t1        '''11111111-1111-1111-1111-111111111111'''
\set t2        '''22222222-2222-2222-2222-222222222222'''
\set t1_int    '''1a000000-0000-0000-0000-000000000001'''
\set t1_acme   '''1a000000-0000-0000-0000-000000000002'''
\set t1_globex '''1a000000-0000-0000-0000-000000000003'''
\set t2_contoso '''2a000000-0000-0000-0000-000000000001'''

\set u_admin1  '''1b000000-0000-0000-0000-000000000001'''
\set u_tech1   '''1b000000-0000-0000-0000-000000000002'''
\set u_acme    '''1b000000-0000-0000-0000-000000000003'''
\set u_ro      '''1b000000-0000-0000-0000-000000000004'''
\set u_admin2  '''2b000000-0000-0000-0000-000000000001'''

\set n_fw      '''1d000000-0000-0000-0000-000000000001'''
\set n_net     '''1d000000-0000-0000-0000-000000000002'''
\set n_dc      '''1d000000-0000-0000-0000-000000000003'''
\set n_app     '''1d000000-0000-0000-0000-000000000004'''
\set n_ssl     '''1d000000-0000-0000-0000-000000000005'''
\set n_dom     '''1d000000-0000-0000-0000-000000000006'''
\set n_gx_srv  '''1d000000-0000-0000-0000-000000000007'''
\set n_t2_fw   '''2d000000-0000-0000-0000-000000000001'''

INSERT INTO tenant (id, slug, name) VALUES
  (:t1, 'northwind-msp', 'Northwind Managed Services'),
  (:t2, 'rival-msp',     'Rival IT Partners');

INSERT INTO organization (id, tenant_id, slug, name, is_msp_internal) VALUES
  (:t1_int,     :t1, 'northwind-internal', 'Northwind (Internal)', true),
  (:t1_acme,    :t1, 'acme',               'Acme Manufacturing',   false),
  (:t1_globex,  :t1, 'globex',             'Globex Corporation',   false),
  (:t2_contoso, :t2, 'contoso',            'Contoso Ltd',          false);

INSERT INTO app_user (id, email, name) VALUES
  (:u_admin1, 'admin@northwind.test',  'Northwind Admin'),
  (:u_tech1,  'tech1@northwind.test',  'Tier One Tech'),
  (:u_acme,   'it@acme.test',          'Acme IT Manager'),
  (:u_ro,     'viewer@acme.test',      'Acme Viewer'),
  (:u_admin2, 'admin@rival.test',      'Rival Admin');

INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all, org_scope, require_step_up) VALUES
  (:t1, :u_admin1, 'super_admin',      true,  NULL, false),
  (:t1, :u_tech1,  'tier1',            true,  NULL, false),
  (:t1, :u_acme,   'client_admin',     false, ARRAY[:t1_acme]::uuid[], false),
  (:t1, :u_ro,     'client_read_only', false, ARRAY[:t1_acme]::uuid[], false),
  (:t2, :u_admin2, 'super_admin',      true,  NULL, false);

-- ---------------------------------------------------------------------------
-- Topology for the graph tests:
--
--   acme-fw-01 --secures--> ACME-LAN  (explicit)
--   acme-fw-01 --member_of--> ACME-LAN (intrinsic, via device.primary_network_id)
--   ACME-DC01  --member_of--> ACME-LAN (intrinsic)
--   crm-app    --hosted_on--> ACME-DC01 (intrinsic, via application.hosted_on_node_id)
--   cert       --secures--> acme.test  (intrinsic, via ssl_certificate.domain_id)
-- ---------------------------------------------------------------------------
INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name, criticality) VALUES
  (:n_net,    :t1, :t1_acme,    'network',         'ACME-LAN VLAN 10',   4),
  (:n_fw,     :t1, :t1_acme,    'device',          'acme-fw-01',         5),
  (:n_dc,     :t1, :t1_acme,    'device',          'ACME-DC01',          5),
  (:n_app,    :t1, :t1_acme,    'application',     'ACME CRM',           3),
  (:n_dom,    :t1, :t1_acme,    'domain',          'acme.test',          5),
  (:n_ssl,    :t1, :t1_acme,    'ssl_certificate', 'wildcard acme.test', 4),
  (:n_gx_srv, :t1, :t1_globex,  'device',          'globex-app-01',      3),
  (:n_t2_fw,  :t2, :t2_contoso, 'device',          'contoso-fw-01',      5);

INSERT INTO network (id, tenant_id, kind, cidr, vlan_id, gateway) VALUES
  (:n_net, :t1, 'vlan', '10.10.0.0/24', 10, '10.10.0.1');

INSERT INTO device (id, tenant_id, device_type, hostname, serial_number, primary_network_id) VALUES
  (:n_fw, :t1, 'firewall', 'acme-fw-01', 'FGT60F0001', :n_net),
  (:n_dc, :t1, 'server',   'acme-dc01',  'DELLDC0001', :n_net);

INSERT INTO device (id, tenant_id, device_type, hostname, serial_number) VALUES
  (:n_gx_srv, :t1, 'server',   'globex-app-01', 'GBX0001'),
  (:n_t2_fw,  :t2, 'firewall', 'contoso-fw-01', 'CTS0001');

INSERT INTO application (id, tenant_id, is_saas, hosted_on_node_id) VALUES
  (:n_app, :t1, false, :n_dc);

INSERT INTO domain (id, tenant_id, domain_name, expires_at) VALUES
  (:n_dom, :t1, 'acme.test', current_date + 200);

INSERT INTO ssl_certificate (id, tenant_id, common_name, not_before, not_after, domain_id) VALUES
  (:n_ssl, :t1, '*.acme.test', now() - interval '30 days', now() + interval '300 days', :n_dom);
