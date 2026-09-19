-- =============================================================================
-- db/tests/fixtures.sql — test data, loaded as a superuser (RLS bypassed).
--
-- Two MSP tenants that must never see each other, and inside the first one, a
-- client administrator who must only ever see their own organisation.
-- =============================================================================

-- Fixed UUIDs so the test script can reference them without lookups.
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

\set sa1       '''1f000000-0000-0000-0000-000000000001'''
\set k1        '''1c000000-0000-0000-0000-000000000001'''
\set k2        '''2c000000-0000-0000-0000-000000000001'''

\set n_fw      '''1d000000-0000-0000-0000-000000000001'''
\set n_net     '''1d000000-0000-0000-0000-000000000002'''
\set n_dc      '''1d000000-0000-0000-0000-000000000003'''
\set n_cred    '''1d000000-0000-0000-0000-000000000004'''
\set n_ssl     '''1d000000-0000-0000-0000-000000000005'''
\set n_dom     '''1d000000-0000-0000-0000-000000000006'''
\set n_gx_srv  '''1d000000-0000-0000-0000-000000000007'''
\set n_wifi    '''1d000000-0000-0000-0000-000000000008'''
\set n_t2_fw   '''2d000000-0000-0000-0000-000000000001'''

\set s_dom_adm '''1e000000-0000-0000-0000-000000000001'''
\set s_wifi    '''1e000000-0000-0000-0000-000000000002'''
\set s_gx      '''1e000000-0000-0000-0000-000000000003'''
\set s_t2      '''2e000000-0000-0000-0000-000000000001'''

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

-- A machine identity. Not a person: it has no membership, no recently-viewed
-- list and no dashboard, which is what the personal-state policies rely on to
-- keep a background job out of somebody's browsing history.
INSERT INTO service_account (id, tenant_id, name, role_key, org_scope_all) VALUES
  (:sa1, :t1, 'expiration-sweeper', 'api_service', true);

INSERT INTO tenant_data_key
  (id, tenant_id, generation, status, wrapped_dek, wrap_provider, kek_id, activated_at)
VALUES
  (:k1, :t1, 1, 'active', gen_random_bytes(184), 'local-dev', 'alias/helm-test-kek', now()),
  (:k2, :t2, 1, 'active', gen_random_bytes(184), 'local-dev', 'alias/helm-test-kek', now());

-- ---------------------------------------------------------------------------
-- Tenant 1 / Acme topology:  firewall -> network,  cert -> domain,  credential
-- ---------------------------------------------------------------------------
INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name, criticality) VALUES
  (:n_net,  :t1, :t1_acme,   'network',         'ACME-LAN VLAN 10',        4),
  (:n_fw,   :t1, :t1_acme,   'device',          'acme-fw-01',              5),
  (:n_dc,   :t1, :t1_acme,   'device',          'ACME-DC01',               5),
  (:n_dom,  :t1, :t1_acme,   'domain',          'acme.test',               5),
  (:n_ssl,  :t1, :t1_acme,   'ssl_certificate', 'wildcard acme.test',      4),
  (:n_cred, :t1, :t1_acme,   'credential',      'ACME Domain Admin',       5),
  (:n_wifi, :t1, :t1_acme,   'credential',      'ACME Guest WiFi',         2),
  (:n_gx_srv, :t1, :t1_globex, 'device',        'globex-app-01',           3),
  (:n_t2_fw,  :t2, :t2_contoso, 'device',       'contoso-fw-01',           5);

INSERT INTO network (id, tenant_id, kind, cidr, vlan_id, gateway) VALUES
  (:n_net, :t1, 'vlan', '10.10.0.0/24', 10, '10.10.0.1');

INSERT INTO device (id, tenant_id, device_type, hostname, manufacturer, model,
                    serial_number, primary_network_id, warranty_expires_at) VALUES
  (:n_fw, :t1, 'firewall', 'acme-fw-01', 'Fortinet', 'FortiGate 60F',
   'FGT60F0001', :n_net, current_date + 45),
  (:n_dc, :t1, 'server', 'acme-dc01', 'Dell', 'PowerEdge R650',
   'DELLDC0001', :n_net, current_date + 400);
UPDATE device SET end_of_life_at = current_date + 900 WHERE id = :n_dc;

INSERT INTO device (id, tenant_id, device_type, hostname, serial_number) VALUES
  (:n_gx_srv, :t1, 'server', 'globex-app-01', 'GBX0001');

INSERT INTO device (id, tenant_id, device_type, hostname, serial_number) VALUES
  (:n_t2_fw, :t2, 'firewall', 'contoso-fw-01', 'CTS0001');

INSERT INTO domain (id, tenant_id, domain_name, registrar, expires_at, auto_renew) VALUES
  (:n_dom, :t1, 'acme.test', 'Example Registrar', current_date + 20, false);

INSERT INTO ssl_certificate (id, tenant_id, common_name, issuer, not_before, not_after, domain_id,
                             installed_on_node_id) VALUES
  (:n_ssl, :t1, '*.acme.test', 'Lets Encrypt', now() - interval '30 days',
   now() + interval '10 days', :n_dom, :n_fw);

-- ---------------------------------------------------------------------------
-- Secrets
-- ---------------------------------------------------------------------------
INSERT INTO secret (id, tenant_id, organization_id, kind, sensitivity, label,
                    requires_step_up, requires_reason, min_role_rank) VALUES
  (:s_dom_adm, :t1, :t1_acme,   'password', 'critical', 'ACME Domain Admin', true,  true,  60),
  (:s_wifi,    :t1, :t1_acme,   'password', 'standard', 'ACME Guest WiFi',   false, false, 40),
  (:s_gx,      :t1, :t1_globex, 'password', 'standard', 'Globex App Admin',  false, false, 40),
  (:s_t2,      :t2, :t2_contoso,'password', 'standard', 'Contoso Router',    false, false, 40);

INSERT INTO secret_version (tenant_id, secret_id, version, data_key_id, ciphertext, nonce, auth_tag, aad,
                            plaintext_length, strength_score) VALUES
  (:t1, :s_dom_adm, 1, :k1, gen_random_bytes(48), gen_random_bytes(12), gen_random_bytes(16),
   '11111111-1111-1111-1111-111111111111|1e000000-0000-0000-0000-000000000001|value|1', 24, 4),
  (:t1, :s_wifi,    1, :k1, gen_random_bytes(32), gen_random_bytes(12), gen_random_bytes(16),
   '11111111-1111-1111-1111-111111111111|1e000000-0000-0000-0000-000000000002|value|1', 16, 3),
  (:t1, :s_gx,      1, :k1, gen_random_bytes(32), gen_random_bytes(12), gen_random_bytes(16),
   '11111111-1111-1111-1111-111111111111|1e000000-0000-0000-0000-000000000003|value|1', 16, 3),
  (:t2, :s_t2,      1, :k2, gen_random_bytes(32), gen_random_bytes(12), gen_random_bytes(16),
   '22222222-2222-2222-2222-222222222222|2e000000-0000-0000-0000-000000000001|value|1', 16, 3);

UPDATE secret SET current_version = 1
WHERE id IN (:s_dom_adm, :s_wifi, :s_gx, :s_t2);

INSERT INTO credential (id, tenant_id, credential_type, username, secret_id, url) VALUES
  (:n_cred, :t1, 'domain_admin', 'ACME\\Administrator', :s_dom_adm, 'https://dc01.acme.test');

-- The guest WiFi password is documented on an ordinary, client-visible
-- credential. Leaving it attached to nothing — as this fixture did until
-- 0460 — made it invisible to every client-side role, which is the new
-- fail-closed default and not what the reveal-ladder tests below are probing.
INSERT INTO credential (id, tenant_id, credential_type, username, secret_id) VALUES
  (:n_wifi, :t1, 'standard_user', 'guest', :s_wifi);

INSERT INTO credential_domain (tenant_id, credential_id, host, match_type, allow_autofill) VALUES
  (:t1, :n_cred, 'dc01.acme.test', 'exact_host', false);

-- An explicit graph edge on top of the intrinsic ones.
INSERT INTO asset_link (tenant_id, source_node_id, target_node_id, relation, origin) VALUES
  (:t1, :n_fw, :n_net, 'secures', 'manual'),
  (:t1, :n_dc, :n_cred, 'authenticates', 'manual');
