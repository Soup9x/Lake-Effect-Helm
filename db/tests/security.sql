-- =============================================================================
-- db/tests/security.sql — isolation and audit guarantees.
-- Run as helm_app. Any failed assertion aborts the run.
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\set t1        '''11111111-1111-1111-1111-111111111111'''
\set t2        '''22222222-2222-2222-2222-222222222222'''
\set t1_acme   '''1a000000-0000-0000-0000-000000000002'''
\set t1_globex '''1a000000-0000-0000-0000-000000000003'''
\set u_admin1  '''1b000000-0000-0000-0000-000000000001'''
\set u_tech1   '''1b000000-0000-0000-0000-000000000002'''
\set u_acme    '''1b000000-0000-0000-0000-000000000003'''
\set u_ro      '''1b000000-0000-0000-0000-000000000004'''
\set u_admin2  '''2b000000-0000-0000-0000-000000000001'''
\set s_dom_adm '''1e000000-0000-0000-0000-000000000001'''
\set s_wifi    '''1e000000-0000-0000-0000-000000000002'''
\set s_gx      '''1e000000-0000-0000-0000-000000000003'''
\set s_t2      '''2e000000-0000-0000-0000-000000000001'''
\set n_fw      '''1d000000-0000-0000-0000-000000000001'''
\set n_net     '''1d000000-0000-0000-0000-000000000002'''
\set n_cred    '''1d000000-0000-0000-0000-000000000004'''
\set k1        '''1c000000-0000-0000-0000-000000000001'''

\echo ''
\echo '== 1. Fail-closed: a connection with no session context sees nothing =='
SELECT helm_test.check('organization returns 0 rows without context',
                       (SELECT count(*) FROM organization) = 0);
SELECT helm_test.check('asset_node returns 0 rows without context',
                       (SELECT count(*) FROM asset_node) = 0);
SELECT helm_test.check('audit_log returns 0 rows without context',
                       (SELECT count(*) FROM audit_log) = 0);
SELECT helm_test.check_raises('writing without context is refused outright',
  $$INSERT INTO organization (tenant_id, slug, name)
    VALUES ('11111111-1111-1111-1111-111111111111', 'sneaky', 'Sneaky')$$);

\echo ''
\echo '== 2. Session context must be opened inside an explicit transaction =='
-- Called at psql top level, so this statement IS the whole transaction:
-- SET LOCAL would evaporate and, behind a transaction-pooling proxy, could leak.
SELECT helm_test.check_raises('set_session_context outside a transaction is refused',
  format('SELECT helm.set_session_context(%L, %L)', :t1, :u_admin1));

\echo ''
\echo '== 3. Tenant isolation =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('T1 super admin sees exactly T1''s 3 organisations',
                       (SELECT count(*) FROM organization) = 3);
SELECT helm_test.check('T1 super admin sees no T2 organisation',
                       NOT EXISTS (SELECT 1 FROM organization WHERE tenant_id = :t2));
SELECT helm_test.check('T1 super admin cannot see the T2 firewall',
                       NOT EXISTS (SELECT 1 FROM device WHERE hostname = 'contoso-fw-01'));
SELECT helm_test.check('T1 super admin cannot see T2 secrets',
                       NOT EXISTS (SELECT 1 FROM secret WHERE tenant_id = :t2));
SELECT helm_test.check('the tenant row itself is scoped',
                       (SELECT count(*) FROM tenant) = 1);
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t2, :u_admin2);
SELECT helm_test.check('T2 super admin sees only Contoso',
                       (SELECT count(*) FROM organization) = 1);
SELECT helm_test.check('T2 super admin cannot see ACME devices',
                       NOT EXISTS (SELECT 1 FROM device WHERE hostname LIKE 'acme%'));
ROLLBACK;

\echo ''
\echo '== 4. Organisation scoping inside one tenant =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_acme);
SELECT helm_test.check('client admin sees only their own organisation',
                       (SELECT count(*) FROM organization) = 1);
SELECT helm_test.check('client admin sees the ACME organisation specifically',
                       (SELECT slug FROM organization) = 'acme');
SELECT helm_test.check('client admin cannot see the Globex server',
                       NOT EXISTS (SELECT 1 FROM device WHERE hostname = 'globex-app-01'));
SELECT helm_test.check('client admin sees ACME assets',
                       (SELECT count(*) FROM asset_node) = 6);
SELECT helm_test.check('client admin cannot see the Globex secret',
                       NOT EXISTS (SELECT 1 FROM secret WHERE id = :s_gx));
SELECT helm_test.check('client admin CAN see that the ACME credential exists',
                       EXISTS (SELECT 1 FROM secret WHERE id = :s_dom_adm));
ROLLBACK;

\echo ''
\echo '== 5. Ciphertext is unreachable by any direct query =='
SELECT helm_test.check_raises('helm_app cannot SELECT secret_version at all',
  'SELECT count(*) FROM secret_version');

\echo ''
\echo '== 6. Reveal authorisation ladder — every refusal is still audited =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_tech1);
CREATE TEMP TABLE r1 AS
  SELECT * FROM helm.reveal_secret(:s_dom_adm, 'ticket 1234 rebuild of DC01', 'view');
SELECT helm_test.check('tier1 is refused a secret requiring rank 60',
                       (SELECT NOT granted FROM r1));
SELECT helm_test.check('refusal reason is insufficient_role_rank',
                       (SELECT denial_reason FROM r1) = 'insufficient_role_rank');
SELECT helm_test.check('refusal returns no ciphertext',
                       (SELECT ciphertext IS NULL FROM r1));
SELECT helm_test.check('refusal wrote an audit event',
                       EXISTS (SELECT 1 FROM audit_log a
                               WHERE a.event_uid = (SELECT audit_event_uid FROM r1)
                                 AND a.action = 'secret.reveal_denied'
                                 AND a.outcome = 'denied'));
COMMIT;   -- commit so the denial audit row survives, which is the whole point

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
CREATE TEMP TABLE r2 AS
  SELECT * FROM helm.reveal_secret(:s_dom_adm, 'ticket 1234 rebuild of DC01', 'view');
SELECT helm_test.check('super admin without step-up is refused a critical secret',
                       (SELECT denial_reason FROM r2) = 'step_up_required');
COMMIT;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
INSERT INTO step_up_verification (tenant_id, user_id, method, expires_at)
  VALUES (:t1, :u_admin1, 'webauthn', now() + interval '15 minutes');
COMMIT;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
CREATE TEMP TABLE r3 AS SELECT * FROM helm.reveal_secret(:s_dom_adm, 'short', 'view');
SELECT helm_test.check('a critical secret still demands a real justification',
                       (SELECT denial_reason FROM r3) = 'reason_required');

CREATE TEMP TABLE r4 AS
  SELECT * FROM helm.reveal_secret(:s_dom_adm, 'INC-4471 emergency DC restore', 'view');
SELECT helm_test.check('with step-up and a reason, the reveal is granted',
                       (SELECT granted FROM r4));
SELECT helm_test.check('granted reveal returns ciphertext',
                       (SELECT octet_length(ciphertext) = 48 FROM r4));
SELECT helm_test.check('granted reveal returns a 12-byte nonce',
                       (SELECT octet_length(nonce) = 12 FROM r4));
SELECT helm_test.check('granted reveal returns a 16-byte auth tag',
                       (SELECT octet_length(auth_tag) = 16 FROM r4));
SELECT helm_test.check('granted reveal returns the wrapped DEK, never a raw key',
                       (SELECT wrapped_dek IS NOT NULL AND kek_id = 'alias/helm-test-kek' FROM r4));
SELECT helm_test.check('granted reveal wrote a secret.revealed audit event',
                       EXISTS (SELECT 1 FROM audit_log a
                               WHERE a.event_uid = (SELECT audit_event_uid FROM r4)
                                 AND a.action = 'secret.revealed'
                                 AND a.outcome = 'success'
                                 AND a.reason = 'INC-4471 emergency DC restore'));
SELECT helm_test.check('audit metadata records purpose and sensitivity, not material',
                       (SELECT a.metadata ->> 'purpose' = 'view'
                               AND a.metadata ->> 'sensitivity' = 'critical'
                               AND NOT (a.metadata ? 'plaintext')
                          FROM audit_log a
                         WHERE a.event_uid = (SELECT audit_event_uid FROM r4)));
COMMIT;

BEGIN;
SELECT helm_test.ctx(:t1, :u_ro);
CREATE TEMP TABLE r5 AS SELECT * FROM helm.reveal_secret(:s_wifi, NULL, 'view');
SELECT helm_test.check('read-only client user has no secret:reveal',
                       (SELECT denial_reason FROM r5) = 'missing_permission');
COMMIT;

BEGIN;
SELECT helm_test.ctx(:t2, :u_admin2);
CREATE TEMP TABLE r6 AS SELECT * FROM helm.reveal_secret(:s_dom_adm, 'probing', 'view');
SELECT helm_test.check('cross-tenant reveal is refused',
                       (SELECT NOT granted FROM r6));
SELECT helm_test.check('cross-tenant refusal says not_found, leaking nothing about existence',
                       (SELECT denial_reason FROM r6) = 'not_found');
COMMIT;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
CREATE TEMP TABLE r7 AS
  SELECT * FROM helm.reveal_secret(:s_dom_adm, 'autofill attempt', 'autofill');
SELECT helm_test.check('critical credentials are never released for browser autofill',
                       (SELECT denial_reason FROM r7) = 'autofill_not_permitted_for_sensitivity');
COMMIT;

\echo ''
\echo '== 7. Audit log is append-only =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check_raises('audit rows cannot be updated',
  $$UPDATE audit_log SET action = 'tampered' WHERE action = 'secret.revealed'$$);
SELECT helm_test.check_raises('audit rows cannot be deleted',
  $$DELETE FROM audit_log WHERE action = 'secret.revealed'$$);
SELECT helm_test.check_raises('audit rows cannot be inserted directly',
  $$INSERT INTO audit_log (tenant_id, actor_type, actor_label, action, chain_seq, prev_hash, row_hash)
    VALUES ('11111111-1111-1111-1111-111111111111', 'user', 'forged', 'secret.revealed',
            1, '\x00'::bytea, '\x00'::bytea)$$);
ROLLBACK;

\echo ''
\echo '== 8. Audit hash chain =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('chain verifies as intact',
                       (SELECT is_intact FROM helm.verify_audit_chain(:t1)));
SELECT helm_test.check('chain covers every event written so far',
                       (SELECT verified_rows FROM helm.verify_audit_chain(:t1))
                       = (SELECT count(*) FROM audit_log WHERE tenant_id = :t1));
SELECT helm_test.check('chain_seq is contiguous from 1',
                       (SELECT last_seq FROM helm.verify_audit_chain(:t1))
                       = (SELECT count(*) FROM audit_log WHERE tenant_id = :t1));
SELECT helm_test.check('each row''s prev_hash equals the previous row''s row_hash',
  (SELECT bool_and(a.prev_hash = prev.row_hash)
   FROM audit_log a
   JOIN audit_log prev ON prev.tenant_id = a.tenant_id AND prev.chain_seq = a.chain_seq - 1
   WHERE a.tenant_id = :t1));
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check_raises('an auditor cannot verify a tenant they are not in',
  format('SELECT * FROM helm.verify_audit_chain(%L)', :t2));
ROLLBACK;

\echo ''
\echo '== 9. Structural tenant integrity (holds even without RLS) =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check_raises('a node cannot reference another tenant''s organisation',
  format($$INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
           VALUES (%L, '2a000000-0000-0000-0000-000000000001', 'device', 'smuggled')$$, :t1));
SELECT helm_test.check_raises('UPDATE cannot move a row into another tenant',
  format($$UPDATE asset_node SET tenant_id = %L WHERE name = 'acme-fw-01'$$, :t2));
SELECT helm_test.check_raises('a device row cannot attach to a node declared as a domain',
  $$INSERT INTO device (id, tenant_id, device_type, hostname)
    VALUES ('1d000000-0000-0000-0000-000000000006',
            '11111111-1111-1111-1111-111111111111', 'server', 'type-confusion')$$);
ROLLBACK;

\echo ''
\echo '== 10. AES-GCM nonce reuse is a hard error =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
-- Recover a nonce already in use under key k1, then try to write new material
-- with it. This goes through the real write path, so it exercises the unique
-- index rather than stopping at a table grant.
CREATE TEMP TABLE used_nonce AS
  SELECT nonce FROM helm.reveal_secret(:s_wifi, NULL, 'rotation');
SELECT helm_test.check('probe recovered a 12-byte nonce',
  (SELECT octet_length(nonce) = 12 FROM used_nonce));
SELECT helm_test.check_raises('reusing a (key, nonce) pair is rejected by the database',
  format($$SELECT helm.write_secret_version(%L, %L, gen_random_bytes(32),
             (SELECT nonce FROM used_nonce), gen_random_bytes(16), 'replayed-aad')$$,
         :s_wifi, :k1));
SELECT helm_test.check('a fresh nonce under the same key is accepted',
  (SELECT version FROM helm.write_secret_version(:s_wifi, :k1, gen_random_bytes(32),
     gen_random_bytes(12), gen_random_bytes(16), 'aad-v2')) = 2);
ROLLBACK;

\echo ''
\echo '== 11. Expiration projection =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('the expiring certificate was projected',
  EXISTS (SELECT 1 FROM expiration WHERE kind = 'ssl_certificate' AND label = '*.acme.test'));
SELECT helm_test.check('the expiring domain was projected',
  EXISTS (SELECT 1 FROM expiration WHERE kind = 'domain_registration' AND label = 'acme.test'));
SELECT helm_test.check('device warranty and EOL are projected as separate rows',
  (SELECT count(*) FROM expiration WHERE kind = 'device_warranty') = 2
  AND (SELECT count(*) FROM expiration WHERE kind = 'device_eol') = 1);
SELECT helm_test.check('a certificate 10 days out on a criticality-4 asset reads critical',
  (SELECT severity FROM v_expiration_dashboard WHERE label = '*.acme.test') = 'critical');
SELECT helm_test.check('days_remaining is computed, not stored',
  (SELECT days_remaining FROM v_expiration_dashboard WHERE label = 'acme.test') BETWEEN 19 AND 21);

UPDATE ssl_certificate SET not_after = now() + interval '400 days'
  WHERE common_name = '*.acme.test';
SELECT helm_test.check('moving the source date updates the projection',
  (SELECT severity FROM v_expiration_dashboard WHERE label = '*.acme.test') = 'info');

DELETE FROM ssl_certificate WHERE common_name = '*.acme.test';
SELECT helm_test.check('deleting the source removes the projected expiry',
  NOT EXISTS (SELECT 1 FROM expiration WHERE label = '*.acme.test'));
ROLLBACK;

\echo ''
\echo '== 12. Bi-directional asset graph =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('the explicit firewall->network edge is visible forward',
  EXISTS (SELECT 1 FROM v_asset_edge
          WHERE from_node_id = :n_fw AND to_node_id = :n_net AND relation = 'secures'));
SELECT helm_test.check('the same edge is visible in reverse with the inverse relation',
  EXISTS (SELECT 1 FROM v_asset_edge
          WHERE from_node_id = :n_net AND to_node_id = :n_fw AND relation = 'secured_by'));
SELECT helm_test.check('the intrinsic device->network edge exists without an asset_link row',
  EXISTS (SELECT 1 FROM v_asset_edge
          WHERE from_node_id = :n_fw AND to_node_id = :n_net
            AND relation = 'member_of' AND origin = 'intrinsic'));
SELECT helm_test.check('the intrinsic edge inverts too',
  EXISTS (SELECT 1 FROM v_asset_edge
          WHERE from_node_id = :n_net AND to_node_id = :n_fw AND relation = 'contains'));
SELECT helm_test.check('walking from the network reaches the firewall and the DC',
  (SELECT count(*) FROM helm.asset_graph_walk(:n_net, 2)) >= 3);
SELECT helm_test.check('the walk terminates on a cyclic graph',
  (SELECT max(depth) FROM helm.asset_graph_walk(:n_net, 3)) <= 3);
ROLLBACK;

-- The graph must stop at the isolation boundary, not merely hide labels.
BEGIN;
SELECT helm_test.ctx(:t1, :u_acme);
SELECT helm_test.check('a client user walking the graph never reaches another org''s node',
  NOT EXISTS (SELECT 1 FROM helm.asset_graph_walk(:n_net, 5)
              WHERE name = 'globex-app-01'));
ROLLBACK;

\echo ''
\echo '== 13. Search index carries no secret material =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('a device is findable by hostname',
  EXISTS (SELECT 1 FROM helm.search('acme-fw-01')));
SELECT helm_test.check('a device is findable by serial number',
  EXISTS (SELECT 1 FROM helm.search('FGT60F0001')));
SELECT helm_test.check('the credential is findable by its name',
  EXISTS (SELECT 1 FROM helm.search('domain admin')));
SELECT helm_test.check('no search document contains ciphertext or a secret id',
  NOT EXISTS (SELECT 1 FROM search_document
              WHERE coalesce(body, '') || coalesce(subtitle, '') ILIKE '%'
                    || (SELECT id::text FROM secret WHERE id = :s_dom_adm) || '%'));
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_acme);
SELECT helm_test.check('search results are organisation-scoped',
  NOT EXISTS (SELECT 1 FROM helm.search('globex')));
ROLLBACK;

\echo ''
\echo '== 14. Flexible assets refuse inline secrets =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
INSERT INTO flexible_asset_type (id, tenant_id, key, name)
  VALUES ('1f000000-0000-0000-0000-000000000001', :t1, 'backup_job', 'Backup Job');
INSERT INTO flexible_asset_type_version
  (id, tenant_id, type_id, version, status, json_schema, secret_fields, searchable_fields, published_at)
VALUES
  ('1f000000-0000-0000-0000-000000000002', :t1, '1f000000-0000-0000-0000-000000000001', 1,
   'published',
   '{"type":"object","properties":{"target":{"type":"string"},"repo_password":{"type":"string","x-helm-secret":true}}}',
   ARRAY['/repo_password'], ARRAY['/target'], now());

INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name)
  VALUES ('1f000000-0000-0000-0000-000000000003', :t1, :t1_acme, 'flexible_asset', 'ACME Nightly Backup');

SELECT helm_test.check_raises('a schema-declared secret field cannot be stored inline',
  $$INSERT INTO flexible_asset_record (id, tenant_id, type_id, type_version_id, data)
    VALUES ('1f000000-0000-0000-0000-000000000003',
            '11111111-1111-1111-1111-111111111111',
            '1f000000-0000-0000-0000-000000000001',
            '1f000000-0000-0000-0000-000000000002',
            '{"target":"nas01","repo_password":"hunter2"}')$$);

INSERT INTO flexible_asset_record (id, tenant_id, type_id, type_version_id, data)
  VALUES ('1f000000-0000-0000-0000-000000000003', :t1,
          '1f000000-0000-0000-0000-000000000001',
          '1f000000-0000-0000-0000-000000000002',
          '{"target":"nas01"}');
SELECT helm_test.check('the same record is accepted with the secret field omitted',
  EXISTS (SELECT 1 FROM flexible_asset_record WHERE id = '1f000000-0000-0000-0000-000000000003'));
SELECT helm_test.check('only allow-listed fields are indexed',
  (SELECT body FROM search_document WHERE entity_id = '1f000000-0000-0000-0000-000000000003') = 'nas01');

SELECT helm_test.check_raises('a published schema body is immutable',
  $$UPDATE flexible_asset_type_version
    SET json_schema = '{"type":"object","properties":{}}'
    WHERE id = '1f000000-0000-0000-0000-000000000002'$$);
ROLLBACK;

\echo ''
\echo '== 15. Secret-bearing exports need a second pair of eyes =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check_raises('a secret-bearing export cannot be self-approved',
  format($$INSERT INTO export_job (tenant_id, organization_id, kind, format,
                                   include_secrets, reason, requested_by, approved_by,
                                   approved_at, expires_at)
           VALUES (%L, %L, 'client_offboarding', 'zip', true,
                   'offboarding handover for Acme', %L, %L, now(), now() + interval '7 days')$$,
         :t1, :t1_acme, :u_admin1, :u_admin1));
-- An unapproved credential-bearing export CAN exist, parked in `queued`. That
-- is the state a reviewer looks at, and making it unrepresentable would force
-- the approver's name into the creation call — one person typing two names,
-- which is not four eyes. The guarantee is about what it may DO, below.
INSERT INTO export_job (id, tenant_id, organization_id, kind, format,
                        include_secrets, reason, requested_by, expires_at)
  VALUES ('e0000000-0000-0000-0000-000000000001', :t1, :t1_acme,
          'client_offboarding', 'zip', true,
          'offboarding handover for Acme', :u_admin1, now() + interval '7 days');
SELECT helm_test.check('an unapproved secret-bearing export may await review',
  EXISTS (SELECT 1 FROM export_job
          WHERE id = 'e0000000-0000-0000-0000-000000000001' AND status = 'queued'));

-- THE guarantee: it cannot start. begin_export_render is the transition into
-- `running`, and running is where credentials get decrypted.
SELECT helm_test.check_raises('an unapproved secret-bearing export cannot start rendering',
  $$SELECT helm.begin_export_render('e0000000-0000-0000-0000-000000000001')$$);

SELECT helm_test.check('an unapproved secret-bearing export is not offered to the render worker',
  NOT EXISTS (SELECT 1 FROM export_job j
              WHERE j.id = 'e0000000-0000-0000-0000-000000000001'
                AND j.include_secrets
                AND j.approved_by IS NOT NULL));

DELETE FROM export_job WHERE id = 'e0000000-0000-0000-0000-000000000001';
-- The supported path: someone else requested it, this session approves it.
-- Going through the function rather than an INSERT is the point — approve_export
-- is what records the scope digest, and a direct INSERT setting approved_by is
-- refused by export_job_approved_scope_recorded precisely so that an approval
-- always says what was approved.
INSERT INTO export_job (id, tenant_id, organization_id, kind, format, include_secrets,
                        reason, requested_by, expires_at)
  VALUES ('e0000000-0000-0000-0000-000000000002', :t1, :t1_acme,
          'client_offboarding', 'zip', true,
          'offboarding handover for Acme', :u_tech1, now() + interval '7 days');

SELECT helm_test.check_raises('an approval must record what was approved',
  format($$UPDATE export_job SET approved_by = %L, approved_at = now()
           WHERE id = 'e0000000-0000-0000-0000-000000000002'$$, :u_admin1));

SELECT helm.approve_export('e0000000-0000-0000-0000-000000000002',
                           'reviewed the scope; handover is contractually due');
SELECT helm_test.check('an export approved by a second person is accepted',
  EXISTS (SELECT 1 FROM export_job
          WHERE id = 'e0000000-0000-0000-0000-000000000002'
            AND approved_by = :u_admin1
            AND approved_scope_sha256 IS NOT NULL));

SELECT helm_test.check_raises('an approved export cannot be approved again',
  $$SELECT helm.approve_export('e0000000-0000-0000-0000-000000000002')$$);
ROLLBACK;

\echo ''
\echo '== 16. Browser-extension autofill resolution =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE credential_domain SET allow_autofill = true WHERE host = 'dc01.acme.test';
SELECT helm_test.check('a critical credential is not offered for autofill even when allowed',
  NOT EXISTS (SELECT 1 FROM helm.resolve_autofill_candidates('dc01.acme.test', 'acme.test')));

INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name)
  VALUES ('1d000000-0000-0000-0000-0000000000aa', :t1, :t1_acme, 'credential', 'ACME Portal Login');
INSERT INTO credential (id, tenant_id, credential_type, username, secret_id)
  VALUES ('1d000000-0000-0000-0000-0000000000aa', :t1, 'standard_user', 'svc-portal', :s_wifi);
INSERT INTO credential_domain (tenant_id, credential_id, host, match_type, allow_autofill)
  VALUES (:t1, '1d000000-0000-0000-0000-0000000000aa', 'portal.acme.test', 'exact_host', true);

SELECT helm_test.check('a standard credential IS offered on an exact host match',
  EXISTS (SELECT 1 FROM helm.resolve_autofill_candidates('portal.acme.test', 'acme.test')));
SELECT helm_test.check('a lookalike domain matches nothing',
  NOT EXISTS (SELECT 1 FROM helm.resolve_autofill_candidates(
                'portal.acme.test.attacker.tld', 'attacker.tld')));
-- Structural, not behavioural: the function's signature must not be capable of
-- returning material, so no future edit can quietly start doing so.
SELECT helm_test.check('autofill resolution cannot return secret material by construction',
  NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proargnames) AS col
    WHERE n.nspname = 'helm'
      AND p.proname = 'resolve_autofill_candidates'
      AND col IN ('ciphertext', 'nonce', 'auth_tag', 'secret_id',
                  'wrapped_dek', 'plaintext', 'aad')));
ROLLBACK;

\echo ''
\echo '== 17. Rotation writes a new version and never overwrites =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
CREATE TEMP TABLE w1 AS SELECT * FROM helm.write_secret_version(
  :s_wifi, :k1, gen_random_bytes(32), gen_random_bytes(12), gen_random_bytes(16),
  'aad-v2', NULL, 4::smallint, 20::smallint, 'quarterly rotation');
SELECT helm_test.check('rotation allocates version 2',
  (SELECT version FROM w1) = 2);
SELECT helm_test.check('secret.current_version advances',
  (SELECT current_version FROM secret WHERE id = :s_wifi) = 2);
SELECT helm_test.check('rotation is audited',
  EXISTS (SELECT 1 FROM audit_log WHERE event_uid = (SELECT audit_event_uid FROM w1)
                                    AND action = 'secret.rotated'));
SELECT helm_test.check('the previous version is still retrievable',
  (SELECT granted FROM helm.reveal_secret(:s_wifi, NULL, 'view', 1)));
ROLLBACK;

\echo ''
\echo '== 18. Writes are rank-gated =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_ro);
SELECT helm_test.check_raises('a read-only client user cannot create an asset',
  format($$INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
           VALUES (%L, %L, 'device', 'unauthorised')$$, :t1, :t1_acme));
-- USING lets the row be targeted (a client user CAN read this asset) but
-- WITH CHECK rejects the rank, so the write fails loudly instead of silently
-- affecting zero rows. That is the behaviour we want: a permissions bug in the
-- UI surfaces as an error, not as an edit that appears to save and does not.
SELECT helm_test.check_raises('a read-only client user''s UPDATE is refused, not silently dropped',
  $$UPDATE asset_node SET name = 'renamed' WHERE name = 'acme-fw-01'$$);
SELECT helm_test.check('the asset is unchanged',
  (SELECT name FROM asset_node WHERE id = :n_fw) = 'acme-fw-01');
ROLLBACK;

\echo ''
\echo '== 19. Revoked and expired access is refused at the door =='
BEGIN;
-- Suspend under an admin context; revoking access is itself a permissioned act.
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE membership SET status = 'suspended' WHERE user_id = :u_tech1 AND tenant_id = :t1;
SELECT helm_test.check('the suspension was written',
  (SELECT status FROM membership WHERE user_id = :u_tech1) = 'suspended');
SELECT helm_test.check_raises('a suspended membership cannot open a session',
  format('SELECT helm.set_session_context(%L, %L)', :t1, :u_tech1));
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE membership SET expires_at = now() - interval '1 day'
  WHERE user_id = :u_tech1 AND tenant_id = :t1;
SELECT helm_test.check_raises('an expired membership cannot open a session',
  format('SELECT helm.set_session_context(%L, %L)', :t1, :u_tech1));
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE app_user SET disabled_at = now() WHERE id = :u_tech1;
SELECT helm_test.check_raises('a disabled user cannot open a session in any tenant',
  format('SELECT helm.set_session_context(%L, %L)', :t1, :u_tech1));
ROLLBACK;

BEGIN;
SELECT helm_test.check_raises('a user with no membership in a tenant cannot enter it',
  format('SELECT helm.set_session_context(%L, %L)', :t2, :u_tech1));
ROLLBACK;

\echo ''
\echo '== 20. Local authentication is unreachable from the request role =='
BEGIN;
-- The whole point of putting local passwords behind helm_auth: a bug anywhere
-- in the request path must not be able to read a hash, mint a reset token, or
-- forge a session.
SELECT helm_test.check('helm_app cannot read a password hash',
  NOT has_column_privilege('helm_app', 'local_credential', 'password_phc', 'SELECT'));
SELECT helm_test.check('helm_app cannot read the password history either',
  NOT has_column_privilege('helm_app', 'local_credential', 'previous_phc', 'SELECT'));
SELECT helm_test.check('no runtime role but helm_auth can read a password hash',
  NOT (has_column_privilege('helm_auditor', 'local_credential', 'password_phc', 'SELECT')
    OR has_column_privilege('helm_worker',  'local_credential', 'password_phc', 'SELECT')
    OR has_column_privilege('helm_key_admin','local_credential','password_phc', 'SELECT')));

SELECT helm_test.check('the throttling ledger is helm_auth''s alone',
  NOT has_table_privilege('helm_app', 'auth_attempt', 'SELECT'));
SELECT helm_test.check('reset tokens are helm_auth''s alone',
  NOT has_table_privilege('helm_app', 'password_reset', 'SELECT'));

SELECT helm_test.check('helm_app cannot run the pre-context login challenge',
  NOT has_function_privilege('helm_app', 'helm.local_login_challenge(text, inet)', 'EXECUTE'));
SELECT helm_test.check('helm_app cannot forge a session',
  NOT has_function_privilege('helm_app',
    'helm.create_local_session(uuid, text, integer, auth_method, inet, text)', 'EXECUTE'));
-- 0360 replaced the three-argument form. Asserting it is gone as well as that
-- the new one is ungranted: an overload left behind would be an ungated
-- session constructor sitting next to a gated one.
SELECT helm_test.check('the session constructor that records nothing is gone',
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'create_local_session' AND p.pronargs = 3));
SELECT helm_test.check('helm_app cannot mint or redeem a reset token',
  NOT (has_function_privilege('helm_app', 'helm.issue_password_reset(uuid, bytea, text, integer, uuid, inet)', 'EXECUTE')
    OR has_function_privilege('helm_app', 'helm.redeem_password_reset(bytea)', 'EXECUTE')));

-- ...and the column grants helm_app DOES hold are the ones its two views need.
-- A security_invoker view over a table the invoker cannot read creates cleanly,
-- grants cleanly, and fails only when somebody opens the page.
SELECT helm_test.check('helm_app can read the columns v_my_local_credential selects',
  has_column_privilege('helm_app', 'local_credential', 'must_change', 'SELECT')
  AND has_column_privilege('helm_app', 'local_credential', 'locked_until', 'SELECT')
  AND has_column_privilege('helm_app', 'local_credential', 'password_changed_at', 'SELECT'));
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
-- Selecting the hash must be refused even for one's own row: the policy scopes
-- which rows are visible, the column grant scopes which columns are.
SELECT helm_test.check_raises('even your own hash is not selectable',
  'SELECT password_phc FROM local_credential');
SELECT helm_test.check('but your own credential state is',
  (SELECT count(*) FROM v_my_local_credential) >= 0);
ROLLBACK;

\echo ''
\echo '== 21. A local session is the same object an SSO session is =='
BEGIN;
-- If these ever diverge, "cut this technician's access now" starts meaning two
-- different things depending on which door they came through.
SELECT helm_test.check('local sign-in writes into auth_session, not a table of its own',
  to_regclass('public.local_session') IS NULL);
SELECT helm_test.check('helm_app cannot read auth_session by any path',
  NOT has_table_privilege('helm_app', 'auth_session', 'SELECT'));
ROLLBACK;

\echo ''
\echo '== 22. Nobody can grant a role that outranks them =='
BEGIN;
-- tier3 holds every permission but three, so it holds user:write, and the
-- membership policies check only the tenant and that permission. Without the
-- 0350 trigger a rank-80 technician could mint themselves a rank-100
-- super_admin membership and be an administrator a moment later.
--
-- Claiming a rank in the GUC is precisely what a compromised request role could
-- do, so that is how this is tested. The tenant context is set too, because the
-- INSERT policy requires one before the trigger is ever reached.
SELECT helm_test.ctx(:t1, :u_admin1);
SET LOCAL helm.role_rank = '80';

SELECT helm_test.check_raises('a rank-80 actor cannot grant super_admin',
  format($$INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all)
           VALUES (%L, %L, 'super_admin', true)$$, :t1, :u_tech1));

SELECT helm_test.check_raises('a client-side role cannot hold tenant-wide scope',
  format($$INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all)
           VALUES (%L, %L, 'client_admin', true)$$, :t1, :u_tech1));

-- And the same actor may grant at or below its own rank: a guard that refused
-- everything would pass both assertions above and be useless.
UPDATE membership SET role_key = 'tier1'
WHERE tenant_id = :t1 AND user_id = :u_tech1;

SELECT helm_test.check('a rank-80 actor can still grant below its own rank',
  (SELECT role_key FROM membership WHERE tenant_id = :t1 AND user_id = :u_tech1) = 'tier1');
ROLLBACK;

\echo ''
\echo '== 23. The RADIUS shared secret is behind the same door as a password hash =='
BEGIN;
-- The secret authenticates the RADIUS SERVER to Helm. Anyone who can read it
-- can forge an Access-Accept and sign in as anybody in the directory, so it
-- belongs behind helm_auth exactly as password_phc does — and NOT in front of
-- helm_app, which renders every page in the product.
--
-- Worth asserting rather than assuming: 0220 sets ALTER DEFAULT PRIVILEGES
-- granting helm_app full DML on tables created by later migrations, so this
-- table arrived readable and had to be explicitly revoked. A future migration
-- that recreates it and forgets will be caught here.
SELECT helm_test.check('helm_app cannot read radius_config',
  NOT has_table_privilege('helm_app', 'radius_config', 'SELECT'));
SELECT helm_test.check('helm_app cannot write radius_config directly',
  NOT has_table_privilege('helm_app', 'radius_config', 'INSERT')
  AND NOT has_table_privilege('helm_app', 'radius_config', 'UPDATE'));
SELECT helm_test.check('the background worker cannot read it either',
  NOT has_table_privilege('helm_worker', 'radius_config', 'SELECT'));
SELECT helm_test.check('nor can the auditor role',
  NOT has_table_privilege('helm_auditor', 'radius_config', 'SELECT'));
SELECT helm_test.check('helm_auth can, because the sign-in path needs it',
  has_table_privilege('helm_auth', 'radius_config', 'SELECT'));

-- Column-level, because one convenient grant on one column is all it takes.
--
-- Enumerated from pg_attribute rather than information_schema.columns, and that
-- is not a style preference: information_schema hides columns the current role
-- has no privilege on, so run as helm_app it returns NOTHING for this table and
-- every column assertion over it passes vacuously. A test that cannot fail is
-- worse than no test, because it reads like coverage.
SELECT helm_test.check('no column of radius_config is readable by helm_app',
  NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.radius_config'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege('helm_app', a.attrelid, a.attnum, 'SELECT')));

-- ...and that the enumeration found columns at all, so the assertion above is
-- quantifying over something.
SELECT helm_test.check('radius_config has columns to have been checked',
  (SELECT count(*) FROM pg_attribute a
   WHERE a.attrelid = 'public.radius_config'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped) > 10);

-- The secret is never stored beside its key: the DEK in the row is WRAPPED, and
-- unwrapping it needs the master key, which lives outside the database
-- entirely. A row read from a stolen dump is not a usable secret.
SELECT helm_test.check('the stored DEK is wrapped, not a bare key',
  EXISTS (SELECT 1 FROM pg_attribute
          WHERE attrelid = 'public.radius_config'::regclass AND attname = 'wrapped_dek')
  AND NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.radius_config'::regclass
      AND attname IN ('shared_secret', 'secret', 'password', 'plaintext')));
ROLLBACK;

\echo ''
\echo '== 24. Your own sessions, and nobody else''s =='
BEGIN;
-- helm_app still cannot touch auth_session (§21), so the account page reaches
-- it through SECURITY DEFINER functions. The risk that introduces is that a
-- definer function is a hole the size of whatever it forgets to filter on.
SELECT helm_test.check('the session helpers are SECURITY DEFINER',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm'
     AND p.proname IN ('my_sessions', 'revoke_my_session', 'revoke_my_other_sessions')
     AND p.prosecdef) = 3);

-- Each one filters on the actor from the session context. A definer function
-- that took a user id as an argument would be an account-takeover primitive.
SELECT helm_test.check('none of them accepts a user id from the caller',
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm'
      AND p.proname IN ('my_sessions', 'revoke_my_session', 'revoke_my_other_sessions')
      AND 'uuid'::regtype::oid = ANY (p.proargtypes)));

SELECT helm_test.check('helm_app still cannot delete from auth_session directly',
  NOT has_table_privilege('helm_app', 'auth_session', 'DELETE'));

-- The reference is a hash, so what the page renders is not a bearer token.
SELECT helm_test.check('a session reference is not the session token',
  helm.session_ref('a-token-that-is-at-least-32-characters-long')
    <> 'a-token-that-is-at-least-32-characters-long');
SELECT helm_test.check('a session reference is 32 hex characters',
  helm.session_ref('a-token-that-is-at-least-32-characters-long') ~ '^[0-9a-f]{32}$');
ROLLBACK;

\echo ''
\echo '== 25. Configuring authentication is a super_admin act =='
BEGIN;
-- tier3 holds every permission except organization:delete, tenant:write and
-- key:rotate. Gating RADIUS on tenant:write is what keeps "change how the whole
-- MSP signs in" out of a senior technician's hands, and it is one seed row away
-- from not being true.
SELECT helm_test.check('tier3 does not hold tenant:write',
  NOT EXISTS (SELECT 1 FROM role_permission
              WHERE role_key = 'tier3' AND permission_key = 'tenant:write'));
SELECT helm_test.check('super_admin does',
  EXISTS (SELECT 1 FROM role_permission
          WHERE role_key = 'super_admin' AND permission_key = 'tenant:write'));
SELECT helm_test.check('no client-side role holds it',
  NOT EXISTS (
    SELECT 1 FROM role_permission rp JOIN app_role r ON r.key = rp.role_key
    WHERE rp.permission_key = 'tenant:write' AND NOT r.is_tenant_wide));
ROLLBACK;

\echo ''
\echo '== All security assertions passed =='
