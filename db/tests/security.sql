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
\set n_dc      '''1d000000-0000-0000-0000-000000000003'''
\set k1        '''1c000000-0000-0000-0000-000000000001'''
\set sa1       '''1f000000-0000-0000-0000-000000000001'''

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
\echo '== 15. A credential export needs ONE authorised person =='
-- CHANGED POSTURE, 0400. This section used to assert that a secret-bearing
-- export could not render until a second person approved it. That requirement
-- was deliberately removed; these assertions are its replacement, and they are
-- written as the INVERSE of the old ones so a silent revert shows up here.
--
-- §35 checks the catalogue — what was dropped, renamed and kept. This section
-- checks BEHAVIOUR, with a real actor, against real rows.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);

-- Requesting is still permissioned, and secret:export is now the whole of the
-- gate rather than the first half of it. u_acme is a client-side user and
-- may never hold it.
SELECT helm_test.ctx(:t1, :u_acme);
SELECT helm_test.check_raises('a user without secret:export cannot request one',
  format($$SELECT helm.request_export(%L, 'client_offboarding'::export_kind, 'zip',
                                      'trying to take the passwords home', true)$$, :t1_acme));
SELECT helm_test.ctx(:t1, :u_admin1);

SELECT helm_test.check_raises('an export still needs a written reason',
  format($$SELECT helm.request_export(%L, 'client_offboarding'::export_kind, 'zip',
                                      'x', true)$$, :t1_acme));

-- THE CHANGE. Under the old rule this row could exist but could not start:
-- begin_export_render refused it and the backlog did not offer it.
INSERT INTO export_job (id, tenant_id, organization_id, kind, format,
                        include_secrets, reason, requested_by, expires_at)
  VALUES ('e0000000-0000-0000-0000-000000000001', :t1, :t1_acme,
          'client_offboarding', 'zip', true,
          'offboarding handover for Acme', :u_admin1, now() + interval '7 days');

SELECT helm_test.check('a secret-bearing export with no approver starts rendering',
  helm.begin_export_render('e0000000-0000-0000-0000-000000000001'));
SELECT helm_test.check('...and is in running, where credentials get decrypted',
  EXISTS (SELECT 1 FROM export_job
          WHERE id = 'e0000000-0000-0000-0000-000000000001' AND status = 'running'));

-- The one that would have shipped a silently EMPTY handover pack. The worker
-- reveals each credential through the 'export' purpose, and that purpose asks
-- is_in_live_secret_export(). While it still asked for an approver, nothing was
-- ever in an approved export and every credential was omitted without an error.
SELECT helm_test.check('the render worker can actually reach the material',
  helm.is_in_live_secret_export(:s_dom_adm));

-- ...and the conditions it DOES still impose, checked by changing the job
-- rather than by reading the function's text.
UPDATE export_job SET revoked_at = now(), status = 'revoked'
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
SELECT helm_test.check('a revoked export stops yielding material immediately',
  NOT helm.is_in_live_secret_export(:s_dom_adm));

UPDATE export_job SET revoked_at = NULL, status = 'queued',
                      expires_at = now() - interval '1 hour'
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
SELECT helm_test.check('an expired export stops yielding material too',
  NOT helm.is_in_live_secret_export(:s_dom_adm));

UPDATE export_job SET expires_at = now() + interval '7 days', include_secrets = false
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
SELECT helm_test.check('a job that never asked for credentials cannot reveal any',
  NOT helm.is_in_live_secret_export(:s_dom_adm));

-- Revocation survived the change. export:approve was renamed to
-- export:revoke_any rather than deleted precisely so this still works: pulling
-- back somebody else's export is the containment action, and removing a gate
-- must not remove the brakes.
UPDATE export_job SET include_secrets = true, requested_by = :u_tech1
  WHERE id = 'e0000000-0000-0000-0000-000000000001';
SELECT helm_test.check('a senior reviewer can still revoke somebody else''s export',
  helm.revoke_export('e0000000-0000-0000-0000-000000000001',
                     'this should not have left the building'));
SELECT helm_test.check('...and the revocation is on the record',
  EXISTS (SELECT 1 FROM audit_log
          WHERE action = 'export.revoked'
            AND entity_id = 'e0000000-0000-0000-0000-000000000001'
            AND actor_id = :u_admin1));
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
\echo '== 26. Personal workspace state is personal, not merely tenant-scoped =='
-- user_favorite, user_recent_view and user_dashboard are scoped by a policy
-- naming both the tenant AND the acting user. Almost every other table in this
-- schema is scoped by tenant alone, so this is the one place where the usual
-- reasoning — "same tenant, therefore visible" — is deliberately wrong.
--
-- It matters because a recently-viewed list is a record of WHICH CLIENTS
-- SOMEBODY HAS BEEN LOOKING AT. In an MSP that is exactly the question the
-- audit log exists to answer under supervision, and not one every colleague
-- should be able to answer casually over the same connection.
--
-- These assertions use a live session context rather than reading pg_policies,
-- because a policy whose text mentions current_actor_id() can still be wrong.
BEGIN;
SELECT helm_test.ctx(:t1, :u_tech1);
INSERT INTO user_favorite (tenant_id, user_id, organization_id)
  VALUES (:t1, :u_tech1, :t1_acme);
SELECT helm.record_view(:t1_acme, NULL);
SELECT helm.record_view(NULL, :n_fw);
INSERT INTO user_dashboard (tenant_id, user_id, widgets)
  VALUES (:t1, :u_tech1, '["favorites","expirations"]'::jsonb);

SELECT helm_test.check('a technician sees their own favourite',
  (SELECT count(*) FROM user_favorite) = 1);
SELECT helm_test.check('...and the two things they just opened',
  (SELECT count(*) FROM user_recent_view) = 2);
SELECT helm_test.check('record_view took the actor from the context, not an argument',
  (SELECT count(*) FROM user_recent_view WHERE user_id = :u_tech1) = 2);

-- Writing a row onto somebody else's list. The INSERT policy's WITH CHECK
-- names the actor, so this is refused rather than silently landing in a
-- colleague's favourites.
SELECT helm_test.check_raises('cannot favourite on another user''s behalf',
  format($$INSERT INTO user_favorite (tenant_id, user_id, organization_id)
           VALUES (%L, %L, %L)$$, :t1, :u_admin1, :t1_globex));

-- And the same for moving an existing row across. USING would find it; the
-- WITH CHECK is what refuses the destination.
SELECT helm_test.check_raises('cannot hand a favourite to another user',
  format($$UPDATE user_favorite SET user_id = %L$$, :u_admin1));

-- A layout the interface cannot render is refused at write time by
-- helm.dashboard_layout_valid(), so a broken dashboard is never a row somebody
-- has to find in the database.
SELECT helm_test.check_raises('an unknown widget key is refused',
  format($$UPDATE user_dashboard SET widgets = '["favorites","not_a_widget"]'::jsonb
           WHERE user_id = %L$$, :u_tech1));
SELECT helm_test.check_raises('a duplicated widget is refused',
  format($$UPDATE user_dashboard SET widgets = '["favorites","favorites"]'::jsonb
           WHERE user_id = %L$$, :u_tech1));
SELECT helm_test.check_raises('a layout that is not an array is refused',
  format($$UPDATE user_dashboard SET widgets = '{"favorites": true}'::jsonb
           WHERE user_id = %L$$, :u_tech1));
SELECT helm_test.check('an empty dashboard is allowed — it is a choice',
  helm.dashboard_layout_valid('[]'::jsonb));
COMMIT;

-- A colleague in the SAME TENANT, on the same connection pool, reading the
-- same tables. This is the assertion the whole section exists for.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('a colleague cannot see the technician''s favourites',
  (SELECT count(*) FROM user_favorite) = 0);
SELECT helm_test.check('nor which clients they have been opening',
  (SELECT count(*) FROM user_recent_view) = 0);
SELECT helm_test.check('nor their dashboard layout',
  (SELECT count(*) FROM user_dashboard) = 0);
SELECT helm_test.check('...not even a super admin, who can see everything else',
  (SELECT count(*) FROM organization) > 1);

-- Deleting what you cannot see. The DELETE policy filters on the actor, so
-- this removes nothing rather than clearing somebody else's list.
DELETE FROM user_favorite;
SELECT helm_test.check('a colleague''s DELETE reaches no row of theirs',
  (SELECT count(*) FROM user_favorite) = 0);
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_tech1);
SELECT helm_test.check('the favourite survived the colleague''s DELETE',
  (SELECT count(*) FROM user_favorite) = 1);
ROLLBACK;

-- Another MSP entirely. §19 establishes that u_tech1 has no membership in T2
-- and cannot open a context there at all, so the live assertion available here
-- is from T2's own administrator: the row is invisible from the other side of
-- the tenant boundary as well as from the next desk.
BEGIN;
SELECT helm_test.ctx(:t2, :u_admin2);
SELECT helm_test.check('another MSP cannot see it either',
  (SELECT count(*) FROM user_favorite) = 0);
SELECT helm_test.check('nor the recently viewed behind it',
  (SELECT count(*) FROM user_recent_view) = 0);
ROLLBACK;

-- What that does NOT establish is the consultant case: one person holding
-- memberships in two MSPs must keep two separate lists, or the names of one
-- MSP's clients appear in the other's interface. No fixture user has two
-- memberships, so this is asserted from the key: tenant_id leads the primary
-- key and the unique indexes, which is what makes the same (user, client) pair
-- two rows rather than one shared one.
SELECT helm_test.check('a favourite is keyed by tenant, not by user alone',
  (SELECT array_agg(a.attname::text ORDER BY k.ord)
     FROM pg_constraint c
     CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.conrelid = 'public.user_favorite'::regclass AND c.contype = 'p')
  = ARRAY['tenant_id', 'user_id', 'organization_id']);
SELECT helm_test.check('so is a dashboard layout',
  (SELECT array_agg(a.attname::text ORDER BY k.ord)
     FROM pg_constraint c
     CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.conrelid = 'public.user_dashboard'::regclass AND c.contype = 'p')
  = ARRAY['tenant_id', 'user_id']);
SELECT helm_test.check('and every unique index on the recent list leads with the tenant',
  NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.user_recent_view'::regclass AND i.indisunique
      AND (SELECT attname::text FROM pg_attribute
           WHERE attrelid = i.indrelid AND attnum = i.indkey[0]) <> 'tenant_id'));

-- The background worker. It is a MEMBER of helm_app, so it holds the table
-- grants by inheritance and no REVOKE can take them away — 0370 says so
-- outright rather than implying a protection that is not there. What keeps it
-- out is the policy: it runs as a service account, and there is no app_user
-- row whose id it carries.
BEGIN;
SELECT helm.set_session_context(:t1, :sa1, 'service_account');
SELECT helm_test.check('a non-person actor sees no personal state at all',
  (SELECT count(*) FROM user_favorite) = 0
  AND (SELECT count(*) FROM user_recent_view) = 0
  AND (SELECT count(*) FROM user_dashboard) = 0);
-- record_view returns quietly rather than raising: a worker touching an
-- organisation is not a person browsing, and a job that fails because it
-- incidentally read a client is worse than one that records nothing.
SELECT helm.record_view(:t1_acme, NULL);
SELECT helm_test.check('record_view records nothing for a non-person actor',
  (SELECT count(*) FROM user_recent_view WHERE user_id = :sa1) = 0);
ROLLBACK;

-- Clean up the rows §26 committed, so a re-run starts where it started.
BEGIN;
SELECT helm_test.ctx(:t1, :u_tech1);
DELETE FROM user_favorite;
DELETE FROM user_recent_view;
DELETE FROM user_dashboard;
COMMIT;

\echo ''
\echo '== 27. Client health is derived, and scoped like everything else =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_acme);
-- v_client_health reads organization, which is behind RLS, so the view is
-- scoped by the tables under it rather than by a filter of its own. A client
-- admin must see a health badge for their own client and no others.
SELECT helm_test.check('a client admin sees health for their own client only',
  (SELECT count(*) FROM v_client_health) = 1);
SELECT helm_test.check('and it is theirs',
  (SELECT organization_id FROM v_client_health) = :t1_acme);
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
-- Every client appears, including the quiet ones. A health view that omits the
-- clients with nothing expiring makes an MSP look busier than it is, and hides
-- the clients nobody is tracking anything for.
SELECT helm_test.check('every visible client has a health row',
  (SELECT count(*) FROM v_client_health)
    = (SELECT count(*) FROM organization WHERE deleted_at IS NULL));
SELECT helm_test.check('health is one of exactly three values',
  NOT EXISTS (SELECT 1 FROM v_client_health WHERE health NOT IN ('red', 'amber', 'green')));
SELECT helm_test.check('a green client has nothing to explain',
  NOT EXISTS (
    SELECT 1 FROM v_client_health
    WHERE health = 'green' AND (expired_count > 0 OR critical_count > 0 OR warning_count > 0)));
-- The severity thresholds are helm.expiration_severity()'s, not a second copy.
-- Asserted by agreement rather than by reading the view definition: if someone
-- inlines their own CASE over days-remaining, these stop matching.
SELECT helm_test.check('red means the expiration dashboard says expired or critical',
  NOT EXISTS (
    SELECT 1 FROM v_client_health h
    WHERE (h.health = 'red') <> EXISTS (
      SELECT 1 FROM v_expiration_dashboard e
      WHERE e.organization_id = h.organization_id
        AND e.severity IN ('expired', 'critical'))));
SELECT helm_test.check('the hover text names at most three things',
  NOT EXISTS (SELECT 1 FROM v_client_health WHERE array_length(reasons, 1) > 3));
ROLLBACK;

-- Every view in the schema, not just this one.
--
-- A view without security_invoker runs with its OWNER's privileges. Every view
-- in db/sql is owned by the migrating role, which bypasses RLS deliberately —
-- so ONE omitted option turns a view into a hole that publishes every tenant's
-- rows to anybody holding SELECT on it, with no error, no warning and no
-- visible difference until somebody looks.
--
-- v_client_health shipped that way for the length of one test run. This
-- assertion is why that was the length of one test run: it is quantified over
-- every view rather than the ones somebody remembered, because the next view is
-- the one nobody will think to check.
SELECT helm_test.check('no view in the schema runs with the owner''s privileges',
  NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
      AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)));
SELECT helm_test.check('...and there are views for that to have been true of',
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'v') >= 8);

\echo ''
\echo '== 28. The search index is not a way around anything =='
-- The index is the least protected copy of the data: denormalised, widely
-- read, and the one table a future Meilisearch mirror would be built from. Two
-- properties have to hold no matter what a projector is later taught to write.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);

-- 1. No secret material, ever. Asserted against the generated blob rather than
--    against any one column, so it covers every field a projector writes and
--    every projector added later.
SELECT helm_test.check('no search document contains a stored credential',
  NOT EXISTS (
    SELECT 1 FROM search_document d
    WHERE d.search_text LIKE '%a-domain-admin-password%'
       OR d.search_text LIKE '%correct horse%'));

-- 2. The blob is GENERATED. A plain column maintained by five projectors is one
--    forgotten assignment away from a document that is findable by word and
--    not by fragment — the hardest kind of search bug to notice, because the
--    feature still works for everything else.
SELECT helm_test.check('search_text is generated, not written',
  (SELECT attgenerated FROM pg_attribute
    WHERE attrelid = 'public.search_document'::regclass AND attname = 'search_text') = 's');
ROLLBACK;

-- Every kind the constraint allows is one the interface groups under. A kind
-- nothing can render is a heading that never appears, which reads to the person
-- searching as "there are none of those".
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('no document carries a kind outside the known set',
  NOT EXISTS (
    SELECT 1 FROM search_document
    WHERE kind NOT IN ('client', 'site', 'credential', 'document', 'asset', 'contact')));
ROLLBACK;

\echo ''
\echo '== 29. Search withholds what a co-managed client may not see =='
-- search_document is scoped by helm.apply_tenant_rls, which names the tenant
-- and the organisation and says NOTHING about is_internal_only. So the flag
-- that marks documentation a client must never see is not enforced by the
-- policy — helm.search() enforces it, and these assertions are what keep that
-- true, because a rewrite of the function would otherwise silently drop it.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE asset_node SET is_internal_only = true, description = 'zzinternalmarker'
 WHERE id = :n_fw;
SELECT helm_test.check('the MSP finds its own internal note',
  EXISTS (SELECT 1 FROM helm.search('zzinternalmarker')));
COMMIT;

BEGIN;
SELECT helm_test.ctx(:t1, :u_acme);
SELECT helm_test.check('a client administrator does NOT',
  NOT EXISTS (SELECT 1 FROM helm.search('zzinternalmarker')));
-- ...and the reason is the flag, not the scoping: the same actor finds other
-- documents belonging to the same client, so this is not vacuous.
SELECT helm_test.check('...and still finds their own non-internal documentation',
  EXISTS (SELECT 1 FROM helm.search('acme')));
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE asset_node SET is_internal_only = false, description = NULL WHERE id = :n_fw;
COMMIT;

SELECT helm_test.check('helm.search is not SECURITY DEFINER',
  NOT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'helm' AND p.proname = 'search'));

\echo ''
\echo '== 30. Archiving is not deleting =='
-- The whole promise of the feature. If a migration ever made archived_at an
-- alias for deleted_at, rows already hidden would become indistinguishable
-- from deleted ones and "recoverable" would quietly stop being true.
SELECT helm_test.check('organization carries BOTH archived_at and deleted_at',
  (SELECT count(*) FROM pg_attribute
    WHERE attrelid = 'public.organization'::regclass
      AND attname IN ('archived_at', 'deleted_at')
      AND attnum > 0 AND NOT attisdropped) = 2);

BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE organization SET archived_at = now() WHERE id = :t1_globex;
SELECT helm_test.check('an archived client keeps its row and its name',
  (SELECT name FROM organization WHERE id = :t1_globex) = 'Globex Corporation');
SELECT helm_test.check('...and is not marked deleted',
  (SELECT deleted_at FROM organization WHERE id = :t1_globex) IS NULL);
SELECT helm_test.check('...and its assets are untouched',
  EXISTS (SELECT 1 FROM asset_node WHERE organization_id = :t1_globex AND archived_at IS NULL));
SELECT helm_test.check('...and it leaves the search index while archived',
  NOT EXISTS (SELECT 1 FROM search_document
              WHERE entity_type = 'organization' AND entity_id = :t1_globex));

UPDATE organization SET archived_at = NULL WHERE id = :t1_globex;
SELECT helm_test.check('restoring puts it back in the index',
  EXISTS (SELECT 1 FROM search_document
          WHERE entity_type = 'organization' AND entity_id = :t1_globex));
ROLLBACK;

\echo ''
\echo '== 31. A bulk action cannot outrank the actor doing it =='
-- Bulk endpoints issue one UPDATE over a set of ids. The protection is that
-- the statement runs under the caller's RLS, so rows the policy refuses are
-- simply not matched — there is no application-side permission check to get
-- wrong. These assertions establish that at the statement level, which is
-- where it actually lives; tests/integration/bulk.test.ts establishes that the
-- route then REFUSES the shortfall rather than half-applying it.
BEGIN;
SELECT helm_test.ctx(:t1, :u_acme);
-- A client administrator may read their own organisation and may not write it.
CREATE TEMP TABLE bulk_probe AS
  SELECT id FROM organization WHERE id IN (:t1_acme, :t1_globex);
SELECT helm_test.check('a client admin sees only their own client in a two-id selection',
  (SELECT count(*) FROM bulk_probe) = 1);
SELECT helm_test.check_raises('...and writing it is refused outright',
  format($$UPDATE organization SET tags = ARRAY['x'] WHERE id = %L$$, :t1_acme));
ROLLBACK;

BEGIN;
SELECT helm_test.ctx(:t1, :u_tech1);
-- tier1 holds asset:write and not organization:write. An UPDATE naming a
-- client it can SEE is still refused, which is the case an application-side
-- check gets wrong: the actor holds the endpoint's declared permission and the
-- loop proceeds.
SELECT helm_test.check('tier1 can see the clients',
  (SELECT count(*) FROM organization) > 1);
SELECT helm_test.check_raises('tier1 cannot archive a client in bulk or otherwise',
  format($$UPDATE organization SET archived_at = now() WHERE id = %L$$, :t1_acme));
-- The other half of the same claim: the refusal above is about clients, not
-- about tier1. A check that only showed the refusal would be satisfied by a
-- policy that refused everything.
WITH touched AS (
  UPDATE asset_node SET archived_at = now() WHERE id = :n_fw RETURNING id
)
SELECT helm_test.check('tier1 CAN archive an asset, so the refusal above is about clients',
  (SELECT count(*) FROM touched) = 1);
ROLLBACK;

\echo ''
\echo '== 32. Internal-only documentation, through every path that reaches it =='
-- Helm's premise is that an MSP can document a co-managed client in the system
-- the client logs into and keep what the client must never see behind a flag.
-- Until 0390 NO POLICY ANYWHERE CONSULTED THAT FLAG: every table carrying it
-- was protected by tenant and organisation scoping alone, which is exactly the
-- scoping a co-managed client PASSES.
--
-- This section is an enumeration of PATHS rather than of tables. The bug was
-- not that one predicate was wrong; it was that the rule lived in nobody's head
-- as a rule, and a dozen query paths each independently did not implement it. A
-- test per table would have the same shape as the bug.
--
-- ONE TRANSACTION, ROLLED BACK. The context is switched mid-transaction — mark
-- as the MSP, read as the client — so the suite leaves no residue. Written as
-- COMMITted setup first, and that was wrong: an assertion failing mid-section
-- left an asset flagged internal in the database, and the NEXT run failed in §4
-- with "client admin sees ACME assets" for reasons that had nothing to do with
-- §4.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);

-- Mark one of everything. That a tenant-wide role can still write these rows
-- is itself the first assertion.
UPDATE asset_node SET is_internal_only = true,
       description = 'zzsecretmarker escalation politics'
 WHERE id = :n_fw;
INSERT INTO note (tenant_id, organization_id, node_id, body, is_internal_only)
VALUES (:t1, :t1_acme, :n_fw, 'zzsecretmarker they are 60 days late paying', true);
INSERT INTO attachment (tenant_id, organization_id, node_id, filename, content_type,
                        byte_size, storage_key, content_sha256, is_internal_only)
VALUES (:t1, :t1_acme, :n_fw, 'zzsecretmarker-margins.xlsx', 'application/vnd.ms-excel',
        2048, 'k/guard', sha256('guard'::bytea), true);
-- The credential under test is the one documenting the internal asset. A
-- credential is hidden by the asset it documents, NOT by
-- credential.client_visible: that column defaults to false and no write path in
-- the product ever sets it, so enforcing it would hide every credential from
-- every client. See helm.secret_node_visible() in 0390.
UPDATE asset_node SET is_internal_only = true WHERE id = :n_cred;

SELECT helm_test.check('the MSP can see the internal asset it just marked',
  EXISTS (SELECT 1 FROM asset_node WHERE id = :n_fw AND is_internal_only));
SELECT helm_test.check('...its internal note',
  EXISTS (SELECT 1 FROM note WHERE is_internal_only AND body LIKE 'zzsecretmarker%'));
SELECT helm_test.check('...its internal attachment',
  EXISTS (SELECT 1 FROM attachment WHERE is_internal_only AND filename LIKE 'zzsecretmarker%'));
SELECT helm_test.check('...and the credential on the internal asset',
  EXISTS (SELECT 1 FROM credential WHERE id = :n_cred));
SELECT helm_test.check('...and that secret''s metadata',
  EXISTS (SELECT 1 FROM v_secret_metadata WHERE id = :s_dom_adm));

-- ---------------------------------------------------------------------------
-- The same rows, same transaction, read by the co-managed client administrator
-- of that very organisation. EVERY ONE of these returned the row before 0390.
-- ---------------------------------------------------------------------------
SELECT helm_test.ctx(:t1, :u_acme);

\echo '-- direct table reads --'
SELECT helm_test.check('asset_node: the internal asset is invisible',
  NOT EXISTS (SELECT 1 FROM asset_node WHERE id = :n_fw));
SELECT helm_test.check('note: the internal note is invisible',
  NOT EXISTS (SELECT 1 FROM note WHERE body LIKE 'zzsecretmarker%'));
SELECT helm_test.check('attachment: the internal file is invisible',
  NOT EXISTS (SELECT 1 FROM attachment WHERE filename LIKE 'zzsecretmarker%'));
SELECT helm_test.check('credential: one on an internal asset is invisible',
  NOT EXISTS (SELECT 1 FROM credential WHERE id = :n_cred));
SELECT helm_test.check('search_document: the indexed copy is invisible',
  NOT EXISTS (SELECT 1 FROM search_document WHERE search_text LIKE '%zzsecretmarker%'));

\echo '-- rows that are ABOUT an internal node without carrying the flag --'
-- expiration.label is the asset's hostname, so this leaked the name itself.
SELECT helm_test.check('expiration: an internal asset''s expiry is invisible',
  NOT EXISTS (SELECT 1 FROM expiration WHERE node_id = :n_fw));
-- secret.label is the credential's name, and v_secret_metadata reads `secret`
-- directly — so hiding the credential row was not enough on its own.
SELECT helm_test.check('secret: the label of a secret on an internal asset is invisible',
  NOT EXISTS (SELECT 1 FROM secret WHERE id = :s_dom_adm));

\echo '-- views, which are security_invoker and inherited the hole --'
SELECT helm_test.check('v_expiration_dashboard',
  NOT EXISTS (SELECT 1 FROM v_expiration_dashboard WHERE node_id = :n_fw));
SELECT helm_test.check('v_secret_metadata',
  NOT EXISTS (SELECT 1 FROM v_secret_metadata WHERE id = :s_dom_adm));
-- The projected branches of v_asset_edge_stored build an edge from a visible
-- subtype row and a bare node id, so they leaked the internal node's uuid and
-- its topology even though the LABELLED view came back empty.
SELECT helm_test.check('v_asset_edge_stored: no edge names it',
  NOT EXISTS (SELECT 1 FROM v_asset_edge_stored
              WHERE source_node_id = :n_fw OR target_node_id = :n_fw));
SELECT helm_test.check('v_asset_edge: nor in either direction',
  NOT EXISTS (SELECT 1 FROM v_asset_edge WHERE from_node_id = :n_fw OR to_node_id = :n_fw));
SELECT helm_test.check('v_asset_edge_labelled',
  NOT EXISTS (SELECT 1 FROM v_asset_edge_labelled
              WHERE from_node_id = :n_fw OR to_node_id = :n_fw));

\echo '-- functions --'
SELECT helm_test.check('helm.search finds nothing',
  NOT EXISTS (SELECT 1 FROM helm.search('zzsecretmarker')));
SELECT helm_test.check('helm.asset_graph_walk cannot reach it from a visible node',
  NOT EXISTS (SELECT 1 FROM helm.asset_graph_walk(:n_net, 3) WHERE node_id = :n_fw));
SELECT helm_test.check('...nor can it be walked FROM, as a root',
  NOT EXISTS (SELECT 1 FROM helm.asset_graph_walk(:n_fw, 3)));

\echo '-- and none of the above is vacuous --'
-- A policy that returned nothing at all would satisfy every assertion above.
-- These establish that the same client, through the same paths, still reads
-- their own documentation.
SELECT helm_test.check('the client still sees their non-internal assets',
  (SELECT count(*) FROM asset_node) >= 4);
SELECT helm_test.check('...their expirations',
  (SELECT count(*) FROM expiration) > 0);
SELECT helm_test.check('...their graph',
  (SELECT count(*) FROM v_asset_edge) > 0);
SELECT helm_test.check('...and search still returns their own documentation',
  EXISTS (SELECT 1 FROM helm.search('acme')));
ROLLBACK;

-- Audit needs its own transaction, because helm.audit() writes a hash-chained
-- row and the reader must see it committed.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE asset_node SET is_internal_only = true WHERE id = :n_fw;
SELECT helm.audit('asset.updated', 'asset_node', :n_fw, 'success', :t1_acme, :n_fw, NULL,
                  '{"label":"zzsecretmarker"}'::jsonb) IS NOT NULL AS wrote_internal;
SELECT helm.audit('asset.updated', 'asset_node', :n_dc, 'success', :t1_acme, :n_dc, NULL,
                  '{"label":"ACME-DC01"}'::jsonb) IS NOT NULL AS wrote_visible;

SELECT helm_test.ctx(:t1, :u_acme);
-- audit metadata quotes what changed, so this leaked the label and the change.
SELECT helm_test.check('audit_log: events about an internal node are invisible',
  NOT EXISTS (SELECT 1 FROM audit_log WHERE node_id = :n_fw));
-- ...and the client's own audit trail is intact, which is the point of giving
-- a co-managed customer audit:read in the first place.
SELECT helm_test.check('...while events about their own assets remain readable',
  EXISTS (SELECT 1 FROM audit_log WHERE node_id = :n_dc));
ROLLBACK;

\echo ''
\echo '== 33. Visibility is load-bearing on the reveal path, not incidental =='
-- helm.reveal_secret is SECURITY DEFINER, so the policies in §32 do not apply
-- inside it. Before 0390 it never consulted visibility at all: a co-managed
-- client was refused only because the shipped client roles hold neither
-- secret:reveal nor a rank reaching any secret. Two coincidences, not a rule —
-- and an MSP granting a client reveal over their own credentials would have
-- found the flag bought them nothing.
--
-- Proving that end to end needs secret:reveal granted to a client role, and
-- this suite runs as helm_app, which cannot write role_permission — correctly,
-- since the request path must never edit the permission catalogue. So the
-- end-to-end version lives in tests/integration/internal-only.test.ts, which
-- has superuser access; what is asserted here is the predicate itself and the
-- shape of the ladder that calls it.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE asset_node SET is_internal_only = true WHERE id = :n_cred;

SELECT helm_test.ctx(:t1, :u_acme);
SELECT helm_test.check('a secret on an internal asset is not visible to a client role',
  NOT helm.secret_node_visible(:s_dom_adm));

SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE asset_node SET is_internal_only = false WHERE id = :n_cred;
SELECT helm_test.ctx(:t1, :u_acme);
-- The other half. Without it the check above is satisfied by a predicate that
-- returns false for everything.
SELECT helm_test.check('...and IS visible once the asset is not internal',
  helm.secret_node_visible(:s_dom_adm));
-- ...and a secret with no credential row at all is left to the controls that
-- always governed it, rather than being hidden by a flag nobody set.
SELECT helm_test.check('a secret with no credential attached is unaffected',
  helm.secret_node_visible(:s_wifi));
ROLLBACK;

-- It must see the truth to report on it: under the caller's own RLS an internal
-- node is invisible, the join inside would find nothing, and the function would
-- report "visible" for exactly the credential it exists to hide.
SELECT helm_test.check('secret_node_visible is SECURITY DEFINER',
  (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'secret_node_visible'));

-- The rung is FIRST in the ladder. Not cosmetic: the audit row records the
-- reason, and "we refused because your rank is too low" is a different fact
-- from "we refused because you may not see this at all" — the second is the
-- one an MSP needs when a client asks why.
SELECT helm_test.check('the reveal ladder tests visibility before permission',
  (SELECT position('secret_node_visible' in pg_get_functiondef(p.oid))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret')
  < (SELECT position('has_permission(''secret:reveal'')' in pg_get_functiondef(p.oid))
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret'));

\echo ''
\echo '== 34. Nothing writes an internal row into a client''s reach =='
-- The flag constrains WRITES as well as reads. Without it on the write side a
-- client actor could not see an internal row but could still UPDATE one blind,
-- or create a row marked internal that they would then be unable to see.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
UPDATE asset_node SET is_internal_only = true WHERE id = :n_fw;

SELECT helm_test.ctx(:t1, :u_acme);
SELECT helm_test.check_raises('a client role cannot create an internal-only asset',
  format($$INSERT INTO asset_node (tenant_id, organization_id, node_type, name, is_internal_only)
           VALUES (%L, %L, 'device', 'smuggled', true)$$, :t1, :t1_acme));
WITH touched AS (
  UPDATE asset_node SET name = 'renamed by the client' WHERE id = :n_fw RETURNING id
)
SELECT helm_test.check('a client role''s UPDATE cannot reach an internal row',
  (SELECT count(*) FROM touched) = 0);
ROLLBACK;

-- Structural, so a future table carrying the flag is not quietly exempt.
SELECT helm_test.check('every policy on a flagged table names the flag',
  NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename IN ('asset_node', 'attachment', 'note', 'search_document')
      AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%internal_visible%'));
-- A credential is hidden by reaching its node, whose policy carries the flag.
-- The reach is what must not be simplified away.
SELECT helm_test.check('...and credential still reaches its node to decide',
  NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'credential' AND cmd IN ('SELECT', 'UPDATE')
      AND coalesce(qual, '') NOT LIKE '%internal_visible%'));
SELECT helm_test.check('...and secret consults the node its credential documents',
  NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'secret' AND cmd = 'SELECT'
      AND coalesce(qual, '') NOT LIKE '%secret_node_visible%'));
SELECT helm_test.check('...and expiration and audit_log name the node check',
  NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE (tablename = 'expiration' OR tablename LIKE 'audit_log%')
      AND cmd = 'SELECT'
      AND coalesce(qual, '') NOT LIKE '%node_visible%'));

\echo ''
\echo '== 35. Credential export: one authorised person, and a trail =='
-- A DELIBERATE CHANGE OF POSTURE made in 0400, not a bug fix. Two-person
-- approval used to park a secret-bearing export until somebody else agreed. It
-- does not any more.
--
-- These assertions exist to stop the change being quietly REVERSED and, just as
-- importantly, from being quietly WIDENED. "Remove the second approver" must
-- not become "remove the controls that were near the second approver", so each
-- removal below is paired with something that must still be there.

\echo '-- the gate is gone --'
SELECT helm_test.check('the approval constraint no longer exists',
  NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'export_job'::regclass
      AND conname = 'export_job_secrets_need_approval'));
SELECT helm_test.check('helm.approve_export no longer exists',
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'approve_export'));
-- The worker's own reveal gate was ALSO approval-shaped. Left alone it would
-- have refused every credential and produced handover packs containing none,
-- silently.
SELECT helm_test.check('the render worker is no longer gated on approval',
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'is_in_approved_export'));
SELECT helm_test.check('...and its replacement still requires a LIVE job asking for secrets',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'is_in_live_secret_export')
  LIKE '%include_secrets%');
SELECT helm_test.check('...and still stops yielding material once revoked',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'is_in_live_secret_export')
  LIKE '%revoked_at IS NULL%');

\echo '-- everything else is still standing --'
SELECT helm_test.check('secret:export still exists and is MSP-only',
  EXISTS (SELECT 1 FROM permission WHERE key = 'secret:export' AND msp_only));
SELECT helm_test.check('no client-side role may export secret material',
  NOT EXISTS (
    SELECT 1 FROM role_permission rp JOIN app_role r ON r.key = rp.role_key
    WHERE rp.permission_key = 'secret:export' AND NOT r.is_tenant_wide));
SELECT helm_test.check('the reveal ladder still gates the export purpose on secret:export',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret')
  LIKE '%export_not_permitted%');
SELECT helm_test.check('...and still applies min_role_rank per secret',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret')
  LIKE '%min_role_rank%');
SELECT helm_test.check('a written reason is still required',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'export_job'::regclass AND conname = 'export_job_reason_present'));
SELECT helm_test.check('a completed secret-bearing bundle must still be encrypted',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'export_job'::regclass
            AND conname = 'export_job_secrets_need_encryption'));

\echo '-- revocation did not go with it --'
-- export:approve was RENAMED, not deleted. helm.revoke_export() gated on it
-- too, so deleting it would have narrowed revocation to the requester alone —
-- taking the brakes off along with the gate.
SELECT helm_test.check('export:approve is gone',
  NOT EXISTS (SELECT 1 FROM permission WHERE key = 'export:approve'));
SELECT helm_test.check('...replaced by a permission that says what it does',
  EXISTS (SELECT 1 FROM permission WHERE key = 'export:revoke_any'));
SELECT helm_test.check('...held by the same senior roles',
  (SELECT count(*) FROM role_permission WHERE permission_key = 'export:revoke_any') >= 2);
SELECT helm_test.check('...and revoke_export still lets them pull back somebody else''s export',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'revoke_export')
  LIKE '%export:revoke_any%');

\echo '-- the audit trail is now the primary safeguard --'
-- It replaced one row saying somebody agreed with a record of what actually
-- happened. Asserted end to end: request, per-credential reveal, render.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
CREATE TEMP TABLE export_probe ON COMMIT DROP AS
  SELECT * FROM helm.request_export(
    :t1_acme, 'client_offboarding'::export_kind, 'zip',
    'contractual handover of all documentation for the audit trail check',
    true, '{}'::jsonb, 72);

-- Stated as the conditions helm.export_backlog() now requires, rather than by
-- calling it: the backlog is granted to helm_worker alone and this suite runs
-- as helm_app. That boundary is deliberate, so the test bends and not the
-- grant. §15 proves the same property the other way round, by actually
-- starting the render.
SELECT helm_test.check('the request is renderable straight away, with no approver',
  EXISTS (
    SELECT 1 FROM export_job j
    WHERE j.id = (SELECT export_job_id FROM export_probe)
      AND j.status = 'queued'
      AND j.approved_by IS NULL
      AND j.revoked_at IS NULL
      AND j.expires_at > now()));
SELECT helm_test.check('...and is recorded with who asked and why',
  EXISTS (
    SELECT 1 FROM audit_log
    WHERE action = 'export.requested'
      AND entity_id = (SELECT export_job_id FROM export_probe)
      AND actor_id = :u_admin1
      AND reason LIKE '%contractual handover%'));
SELECT helm_test.check('...naming that it carries credentials',
  (SELECT metadata ->> 'include_secrets' FROM audit_log
    WHERE action = 'export.requested'
      AND entity_id = (SELECT export_job_id FROM export_probe)) = 'true');
ROLLBACK;

-- The per-credential record is what makes "who exported WHAT" answerable, and
-- it comes from the reveal ladder rather than from the export engine.
SELECT helm_test.check('a reveal for export writes one audit row per secret',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'reveal_secret')
  LIKE '%secret.revealed%');
SELECT helm_test.check('and the audit log is still append-only',
  EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'audit_log' AND NOT t.tgisinternal));

\echo ''
\echo '== 36. A generic OIDC provider is a pre-authentication secret =='
-- 0410 added a fourth sign-in door. The client secret is presented to an
-- identity provider BEFORE anybody is signed in, so it sits behind helm_auth
-- exactly as radius_config and local_credential.password_phc do — and this
-- section asserts that boundary the same way §22 asserts the RADIUS one.
--
-- Written as catalogue checks rather than behavioural ones because the property
-- is a GRANT: there is no query helm_app could run to demonstrate it, which is
-- the whole point.

\echo '-- the client secret is not reachable from the application role --'
SELECT helm_test.check('helm_app cannot read oidc_provider, by any column',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_name = 'oidc_provider'
      AND has_column_privilege('helm_app', 'oidc_provider', c.column_name, 'SELECT')));
-- helm_worker is a MEMBER of helm_app, so a REVOKE naming it is a no-op and it
-- has to be checked in its own right. This has caught a real regression before.
SELECT helm_test.check('nor helm_worker, which inherits helm_app',
  NOT has_table_privilege('helm_worker', 'oidc_provider', 'SELECT'));
SELECT helm_test.check('nor the auditor',
  NOT has_table_privilege('helm_auditor', 'oidc_provider', 'SELECT'));
SELECT helm_test.check('nor the key administrator',
  NOT has_table_privilege('helm_key_admin', 'oidc_provider', 'SELECT'));
SELECT helm_test.check('helm_auth can, because pre-authentication is its job',
  has_table_privilege('helm_auth', 'oidc_provider', 'SELECT'));

SELECT helm_test.check('the secret-bearing lookups are helm_auth only',
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm'
      AND p.proname IN ('oidc_provider_by_slug', 'oidc_provider_for_tenant')
      AND has_function_privilege('helm_app', p.oid, 'EXECUTE')));

\echo '-- ...but the application can still configure one --'
-- Write without read. A settings page that cannot save is as broken as one
-- that leaks, and this is the shape that gives neither.
SELECT helm_test.check('helm_app may write the provider and its sealed secret',
  has_function_privilege('helm_app',
    'helm.set_oidc_provider(boolean, text, text, text, text, text[], boolean, boolean, text, text, bytea, bytea, bytea, bytea, text)',
    'EXECUTE'));
SELECT helm_test.check('helm_app may read the settings WITHOUT the envelope',
  has_function_privilege('helm_app', 'helm.oidc_settings()', 'EXECUTE'));
SELECT helm_test.check('...and that function''s result type has no secret in it',
  (SELECT pg_get_function_result(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'oidc_settings')
  NOT LIKE '%ciphertext%');

\echo '-- helm_app still cannot reach auth_session --'
-- §21 of the security model. The session-stamping function added by 0410 writes
-- to auth_session, so granting it to helm_app would erase that boundary by a
-- side door.
SELECT helm_test.check('the session stamp is not executable by helm_app',
  NOT has_function_privilege('helm_app',
    'helm.stamp_session_method(text, auth_method, inet, text)', 'EXECUTE'));
SELECT helm_test.check('...and helm_app still cannot read auth_session at all',
  NOT has_table_privilege('helm_app', 'auth_session', 'SELECT'));

\echo '-- configuring a door is tenant:write, not integration:manage --'
-- Changing how an entire MSP authenticates is a larger act than configuring an
-- integration, and integration:manage reaches down to tier3.
SELECT helm_test.check('tenant:write exists and is MSP-only',
  EXISTS (SELECT 1 FROM permission WHERE key = 'tenant:write' AND msp_only));
SELECT helm_test.check('tier3 does not hold it, though it holds nearly everything',
  NOT EXISTS (SELECT 1 FROM role_permission
              WHERE role_key = 'tier3' AND permission_key = 'tenant:write'));
SELECT helm_test.check('super_admin does',
  EXISTS (SELECT 1 FROM role_permission
          WHERE role_key = 'super_admin' AND permission_key = 'tenant:write'));

\echo '-- the stored shape cannot be a plaintext or unsigned configuration --'
SELECT helm_test.check('an https issuer is required',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'oidc_provider'::regclass AND conname = 'oidc_issuer_https'));
SELECT helm_test.check('openid is required among the scopes',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'oidc_provider'::regclass AND conname = 'oidc_scopes_openid'));
SELECT helm_test.check('a slug cannot shadow a built-in provider id',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'oidc_provider'::regclass AND conname = 'oidc_slug_not_reserved'));
SELECT helm_test.check('the nonce is a GCM nonce',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'oidc_provider'::regclass AND conname = 'oidc_nonce_len'));
SELECT helm_test.check('a slug is unique across the deployment, since the callback path has no tenant',
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'oidc_provider'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%(slug)%'));

\echo ''
\echo '== 37. A notification leaves the building =='
-- 0420 turned webhook_endpoint/webhook_delivery from 0110 scaffolding into a
-- live path that POSTs to chat platforms. Two boundaries matter, and they are
-- different in kind.

\echo '-- the destination URL is a credential --'
-- For Discord and Teams the URL IS the authentication: whoever holds it can
-- post as Helm. 0110 stored it in plaintext in a table any tenant-wide role of
-- rank 60 or more could read.
SELECT helm_test.check('helm_app cannot read webhook_endpoint, by any column',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_name = 'webhook_endpoint'
      AND has_column_privilege('helm_app', 'webhook_endpoint', c.column_name, 'SELECT')));
SELECT helm_test.check('nor the auditor',
  NOT has_table_privilege('helm_auditor', 'webhook_endpoint', 'SELECT'));
SELECT helm_test.check('nor the key administrator',
  NOT has_table_privilege('helm_key_admin', 'webhook_endpoint', 'SELECT'));
-- helm_worker CAN, because delivering is its job. This is the one boundary in
-- the schema where the reading role is the worker rather than helm_auth.
SELECT helm_test.check('helm_worker can, because delivery is a background job',
  has_table_privilege('helm_worker', 'webhook_endpoint', 'SELECT'));
SELECT helm_test.check('the plaintext url column is gone',
  NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.webhook_endpoint'::regclass AND attname = 'url'
      AND attnum > 0 AND NOT attisdropped));
SELECT helm_test.check('...and so is the vault reference that signing used to go through',
  NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.webhook_endpoint'::regclass AND attname = 'signing_secret_id'
      AND attnum > 0 AND NOT attisdropped));
SELECT helm_test.check('the envelope is all-or-nothing',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'webhook_endpoint'::regclass
            AND conname = 'webhook_envelope_complete'));

\echo '-- ...but the application can still configure one --'
SELECT helm_test.check('helm_app may write a destination and its sealed URL',
  has_function_privilege('helm_app',
    'helm.set_webhook_endpoint(uuid, text, webhook_format, boolean, uuid, text[], text, text, boolean, smallint, integer, text, text, bytea, bytea, bytea, bytea, text)',
    'EXECUTE'));
SELECT helm_test.check('...and read back everything EXCEPT the envelope',
  (SELECT pg_get_function_result(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'webhook_endpoints')
  NOT LIKE '%ciphertext%');

\echo '-- what reaches a payload is an ALLOW-LIST, not a denylist --'
-- The load-bearing control. An audit action that grows a new metadata field
-- does not start appearing in notifications; somebody has to name it.
SELECT helm_test.check('helm_app cannot insert a delivery directly',
  NOT has_table_privilege('helm_app', 'webhook_delivery', 'INSERT'));
SELECT helm_test.check('...nor update one',
  NOT has_table_privilege('helm_app', 'webhook_delivery', 'UPDATE'));
SELECT helm_test.check('it may READ them, for the settings page',
  has_table_privilege('helm_app', 'webhook_delivery', 'SELECT'));
SELECT helm_test.check('an export payload carries only the four named keys',
  helm.notification_payload('export.requested',
    '{"kind":"x","format":"zip","include_secrets":true,"expires_in_hours":72,
      "scope":{"nodeIds":["a"]},"something_new":"leaked"}'::jsonb)
  = '{"kind":"x","format":"zip","include_secrets":true,"expires_in_hours":72}'::jsonb);
SELECT helm_test.check('a reveal payload drops data_key_id, which nobody listed',
  NOT (helm.notification_payload('secret.revealed',
    '{"label":"ACME Domain Admin","purpose":"export","data_key_id":"abc"}'::jsonb) ? 'data_key_id'));
SELECT helm_test.check('an unknown event yields an empty payload, never a passthrough',
  helm.notification_payload('not.an.event', '{"password":"hunter2"}'::jsonb) = '{}'::jsonb);

\echo '-- and the trigger behind it walks nested objects --'
-- 0110's version tested TOP-LEVEL KEYS ONLY, so {"detail":{"password":...}}
-- passed. Survivable while nothing wrote to the table; not survivable now that
-- these rows are POSTed to a chat platform.
SELECT helm_test.check('the no-secrets trigger is attached',
  EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'webhook_delivery' AND t.tgname = 'webhook_delivery_no_secrets'
      AND NOT t.tgisinternal));
SELECT helm_test.check('...and it really recurses',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'reject_secret_bearing_payload')
  LIKE '%$.**%');

\echo '-- the event vocabulary is closed --'
-- A typo in a subscription is otherwise a channel that is simply never written
-- to, with nothing anywhere to say why.
SELECT helm_test.check('a destination cannot subscribe to an event Helm cannot raise',
  NOT helm.notification_events_known(ARRAY['export.requestd']));
SELECT helm_test.check('...and the real ones are accepted',
  helm.notification_events_known(ARRAY['export.requested', 'access.denied']));
SELECT helm_test.check('a CHECK enforces it on the table',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'webhook_endpoint'::regclass AND conname = 'webhook_events_known'));
SELECT helm_test.check('every audit action that maps to an event maps to a known one',
  NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'export.requested', 'export.rendered', 'export.downloaded', 'export.revoked',
      'secret.revealed', 'secret.reveal_denied', 'secret.write_denied',
      'export.download_denied', 'key.rotation_started'
    ]) AS action
    WHERE helm.notification_event_for(action, 'success') IS NOT NULL
      AND NOT helm.notification_events_known(
        ARRAY[helm.notification_event_for(action, 'success')])));

\echo '-- an ordinary audit action queues nothing --'
-- The common case, and what keeps the fan-out cheap: a tenant doing ordinary
-- work produces hundreds of audit rows an hour and none of them are events.
SELECT helm_test.check('an organisation edit is not a notification',
  helm.notification_event_for('organization.updated', 'success') IS NULL);
SELECT helm_test.check('a successful sync is not a notification',
  helm.notification_event_for('integration.sync_finished', 'success') IS NULL);
SELECT helm_test.check('...but a failed one is',
  helm.notification_event_for('integration.sync_finished', 'error') = 'integration.failed');

\echo ''
\echo '== 38. A network controller is an integration, not a second vault =='
-- 0430 gave Helm its first integration that both HOLDS a credential and WRITES
-- tenant data on a schedule with no human present. Three things could go wrong
-- quietly, and each has an assertion here rather than a comment somewhere:
--
--   * the controller's API key becomes a bespoke encrypted column, sitting
--     outside the reveal ladder and outside the audit trail;
--   * the permission to configure one drags tenant-wide authority along with
--     it, so "let this technician manage the client's APs" also hands over the
--     tenant's authentication settings;
--   * the poller, which runs cross-tenant by construction, becomes reachable
--     from the request path.

\echo '-- the API key lives in the vault, like every other credential --'
-- ONE NAMED EXCEPTION, and it is worth spelling out because this assertion
-- caught it rather than waving it through.
--
-- 0450 added webhook_secret_ciphertext, the INBOUND signing secret. That one is
-- a column deliberately: the receiver is unauthenticated, so verifying the
-- signature is what establishes whose request it is — there is no actor for
-- reveal_secret() to attribute a read to and no tenant context to open one
-- under, and a reveal per inbound event would write an audit row per inbound
-- event. 0420 reached the same conclusion for the outbound signing secret.
--
-- The rule it does NOT get an exception from is the one that matters: the
-- controller's API key, which a person can ask to see and which unlocks the
-- whole inventory, is still a reference into `secret`. So the check is narrowed
-- to its actual intent and the exception is named, rather than the pattern
-- being loosened until it stops meaning anything.
SELECT helm_test.check('the mapping has no bespoke credential column but the named one',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'unifi_site_mapping'
      AND column_name ~ '(api_key|credential|secret|token|password)s?_(enc|ciphertext|plain)$'
      AND column_name <> 'webhook_secret_ciphertext'));
SELECT helm_test.check('...and the exception is exactly the inbound signing envelope',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'unifi_site_mapping'
      AND column_name ~ '(api_key|credential|secret|token|password)s?_(enc|ciphertext|plain)$') = 1);
SELECT helm_test.check('the API KEY in particular is still a reference, not a column',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'unifi_site_mapping' AND column_name ~ '^api_key_(enc|ciphertext)'));
SELECT helm_test.check('it references secret instead',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'unifi_site_mapping'::regclass AND conname = 'unifi_mapping_secret_fk'));
-- Composite, so a mapping cannot be pointed at a secret belonging to another
-- tenant: the FK itself refuses it, without depending on RLS being switched on.
SELECT helm_test.check('...and the reference carries the tenant, so it cannot cross one',
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'unifi_site_mapping'::regclass AND conname = 'unifi_mapping_secret_fk')
  LIKE '%(api_key_secret_id, tenant_id)%');
-- RESTRICT rather than SET NULL: deleting the credential out from under a live
-- mapping would leave a controller configured, active, and unpollable, with
-- nothing to say why.
SELECT helm_test.check('deleting the secret out from under a mapping is refused',
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'unifi_site_mapping'::regclass AND conname = 'unifi_mapping_secret_fk')
  LIKE '%ON DELETE RESTRICT%');
-- Without this the sync is refused 'not_an_integration_credential' on every
-- poll — and the failure would be a stuck integration, not an insecure one,
-- which is why it needs asserting rather than trusting to the first test run.
SELECT helm_test.check('the reveal ladder recognises a UniFi key as an integration credential',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'is_integration_credential')
  LIKE '%unifi_site_mapping%');

\echo '-- managing a controller is its own grant --'
-- The brief's central ask: grantable to a trusted technician WITHOUT handing
-- over the tenant. tier3 holding it while not holding tenant:write is the whole
-- proof, and it is the assertion that fails the day someone "simplifies" this
-- back into tenant:write or a shared integration:manage.
SELECT helm_test.check('the permission exists',
  EXISTS (SELECT 1 FROM permission WHERE key = 'integration:network:manage'));
SELECT helm_test.check('tier3 holds it',
  EXISTS (SELECT 1 FROM role_permission
          WHERE role_key = 'tier3' AND permission_key = 'integration:network:manage'));
SELECT helm_test.check('...without holding tenant:write',
  NOT EXISTS (SELECT 1 FROM role_permission
              WHERE role_key = 'tier3' AND permission_key = 'tenant:write'));
SELECT helm_test.check('...which is what makes it delegable at all',
  EXISTS (SELECT 1 FROM role_permission WHERE permission_key = 'tenant:write'));
SELECT helm_test.check('no client-facing role holds it',
  NOT EXISTS (
    SELECT 1 FROM role_permission
    WHERE permission_key = 'integration:network:manage'
      AND role_key IN ('client_admin', 'client_read_only', 'tier1', 'tier2', 'api_service')));
-- The worker polls controllers; it does not configure them. Granting it this
-- for convenience would let a stolen sync token repoint a mapping at a
-- collector the attacker owns.
SELECT helm_test.check('the sync service account cannot configure a controller either',
  NOT EXISTS (SELECT 1 FROM role_permission
              WHERE role_key = 'system_sync' AND permission_key = 'integration:network:manage'));

\echo '-- the cross-tenant poller is the worker''s alone --'
-- helm.unifi_poll_backlog returns rows for every tenant by construction: it is
-- what the scheduler reads before any tenant context exists. Reachable from the
-- request path it would be a complete enumeration of every MSP client's
-- network gear.
SELECT helm_test.check('helm_app cannot enumerate every tenant''s controllers',
  NOT has_function_privilege('helm_app', 'helm.unifi_poll_backlog(integer)', 'EXECUTE'));
-- Checked in its own right because helm_worker is a MEMBER of helm_app: a
-- REVOKE naming helm_worker is a no-op, and membership only runs one way.
SELECT helm_test.check('nor the auditor',
  NOT has_function_privilege('helm_auditor', 'helm.unifi_poll_backlog(integer)', 'EXECUTE'));
SELECT helm_test.check('nor the key administrator',
  NOT has_function_privilege('helm_key_admin', 'helm.unifi_poll_backlog(integer)', 'EXECUTE'));
SELECT helm_test.check('the worker can, because that is its job',
  has_function_privilege('helm_worker', 'helm.unifi_poll_backlog(integer)', 'EXECUTE'));
SELECT helm_test.check('the asset upsert is the worker''s too',
  NOT has_function_privilege('helm_app',
    'helm.upsert_network_asset(uuid, uuid, uuid, network_asset_type, bytea, uuid, bytea, bytea, bytea, bytea, text, text, text, bigint, smallint, integer, bytea, integer, text, boolean, timestamptz)',
    'EXECUTE'));

\echo '-- only what identifies a machine is encrypted --'
-- Stated as an assertion because the tempting shortcut is to seal the whole
-- telemetry payload, which protects nothing and makes "which APs are on old
-- firmware" unanswerable in SQL. A change of mind here should have to delete a
-- test that says why.
SELECT helm_test.check('MAC, IP, hostname and serial are ciphertext',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'network_assets'
      AND column_name IN ('mac_address_enc', 'ip_address_enc', 'hostname_enc', 'serial_enc')
      AND data_type <> 'bytea'));
SELECT helm_test.check('...and the telemetry beside them is still queryable',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'network_assets'
      AND column_name IN ('model', 'firmware_version', 'device_state', 'ssid')
      AND data_type = 'bytea'));
SELECT helm_test.check('the blind index is the identity, and is mandatory',
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'network_assets'
      AND column_name = 'mac_blind_index' AND is_nullable = 'NO'));
SELECT helm_test.check('...and is unique within a tenant, so a poll cannot duplicate a device',
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'network_assets'::regclass AND contype IN ('u', 'p')
      AND pg_get_constraintdef(oid) LIKE '%(tenant_id, mac_blind_index)%'));
SELECT helm_test.check('an IP history row is indexed blind as well',
  EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'asset_ip_history'::regclass
      AND pg_get_indexdef(i.indexrelid) LIKE '%ip_blind_index%'));

\echo '-- a poll cannot overwrite what a person wrote --'
-- Read out of the function definition rather than demonstrated, because the
-- failure mode is an ADDED line in the UPDATE branch on a tired afternoon, and
-- a behavioural test only catches the columns it happens to name.
SELECT helm_test.check('the upsert names no user-owned column in its UPDATE branch',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'upsert_network_asset')
  !~ '(custom_name_enc|asset_tag|department|notes|maintenance_status)\s*=\s*EXCLUDED');
-- Every encrypted column is sealed against an AAD naming the row's id, so the
-- id must exist before the ciphertext does. Letting the default mint it wrote
-- rows whose every field was permanently unreadable, and the insert looked
-- perfectly clean because nothing decrypted it.
SELECT helm_test.check('the upsert inserts the id its ciphertext is bound to',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'upsert_network_asset')
  ~ 'VALUES\s*\(\s*p_asset_id');

\echo '-- TLS verification cannot be switched off, only narrowed --'
-- A self-hosted controller on a private IP genuinely does present a self-signed
-- certificate, so a flat refusal would just push operators to a global disable
-- flag. The exception is per mapping, must name a specific fingerprint, and
-- must record who accepted it.
SELECT helm_test.check('verification off with nothing pinned is unrepresentable',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'unifi_site_mapping'::regclass
            AND conname = 'unifi_mapping_no_blanket_disable'));
SELECT helm_test.check('a pin without an acknowledgment is unrepresentable',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'unifi_site_mapping'::regclass
            AND conname = 'unifi_mapping_pin_acknowledged'));
SELECT helm_test.check('and the acknowledgment names a person and a time',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'unifi_site_mapping'
      AND column_name IN ('tls_exception_ack_by', 'tls_exception_ack_at')) = 2);

\echo '-- and the inventory is tenant data like any other --'
SELECT helm_test.check('every UniFi table carries RLS, forced',
  NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('unifi_site_mapping', 'network_assets', 'asset_ip_history')
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)));

-- Behavioural, because the catalogue check above proves the switch is on and
-- says nothing about the policy being right. One tenant writes an asset; the
-- other cannot see it, count it, or take it.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
INSERT INTO network_assets (
  tenant_id, organization_id, asset_type, mac_blind_index, data_key_id,
  mac_address_enc, hostname_enc, model, firmware_version)
VALUES (
  :t1, :t1_acme, 'unifi_device',
  decode(repeat('ab', 32), 'hex'),
  (SELECT id FROM tenant_data_key WHERE tenant_id = :t1 AND status = 'active' LIMIT 1),
  decode(repeat('cd', 40), 'hex'), decode(repeat('ef', 40), 'hex'),
  'U6-Pro', '6.6.65');
SELECT helm_test.check('the writing tenant sees its own asset',
  (SELECT count(*) FROM network_assets WHERE model = 'U6-Pro') = 1);

SELECT helm_test.ctx(:t2, :u_admin2);
SELECT helm_test.check('the other tenant cannot see it',
  NOT EXISTS (SELECT 1 FROM network_assets WHERE model = 'U6-Pro'));
SELECT helm_test.check('...nor count it',
  (SELECT count(*) FROM network_assets) = 0);
-- The MAC is the join key across the whole integration, so a lookup by blind
-- index is the query an attacker would actually write.
SELECT helm_test.check('...nor find it by its blind index, which is the real lookup',
  NOT EXISTS (
    SELECT 1 FROM network_assets WHERE mac_blind_index = decode(repeat('ab', 32), 'hex')));
-- An UPDATE that matches no row succeeds having done nothing, which is the
-- correct RLS outcome and is worth pinning: a policy that let it through would
-- move another tenant's device into this one.
-- A DO block rather than a CTE: a data-modifying WITH is only legal at the top
-- level, and this needs the row count as a value. No psql variables inside, so
-- the dollar-quoting is safe.
DO $steal$
DECLARE v_rows integer;
BEGIN
  UPDATE network_assets SET organization_id = organization_id WHERE model = 'U6-Pro';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM helm_test.check('...and cannot take it by UPDATE', v_rows = 0);
END;
$steal$;
ROLLBACK;

\echo ''
\echo '== 39. A webhook receiver is a door, and it is only ever a shortcut =='
-- 0450 gave Helm its first UNAUTHENTICATED endpoint that writes tenant data.
-- Three things had to be true for that to be acceptable, and each is asserted
-- here rather than trusted to the route:
--
--   * the only lookup that crosses a tenant boundary is by primary key and
--     hands back no credential the request path could misuse;
--   * the fast path obeys every rule the poll obeys, because two write paths
--     into one table is how a rule ends up enforced on only one of them;
--   * nothing the poll does depends on any of it. Webhook support is not
--     guaranteed on a UniFi console, so an integration that needed it would be
--     broken on an unknown fraction of deployments with no way to tell which.

\echo '-- the signing secret is not reachable, and not reported --'
-- It is a column here rather than a vault secret because the receiver is
-- unauthenticated: there is no actor for reveal_secret() to attribute a read
-- to, and an audit row per inbound event would bury the threat records this
-- exists to produce. 0420 made the same call for the outbound secret. What
-- follows is the boundary that buys back.
SELECT helm_test.check('the settings function reports only WHETHER a secret is set',
  (SELECT pg_get_function_result(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'unifi_mappings')
  !~* '(ciphertext|wrapped_dek|secret_nonce|secret_tag|secret_aad)');
SELECT helm_test.check('...and it does report that much, so the page can say so',
  (SELECT pg_get_function_result(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'unifi_mappings')
  LIKE '%webhook_secret_set%');
SELECT helm_test.check('the envelope is all-or-nothing',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'unifi_site_mapping'::regclass
            AND conname = 'unifi_webhook_envelope_complete'));
-- A mapping cannot claim to be listening with nothing to verify against;
-- otherwise the receiver would be deciding what to do with an unverifiable
-- request rather than refusing it outright.
SELECT helm_test.check('a mapping cannot listen without a secret',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'unifi_site_mapping'::regclass
            AND conname = 'unifi_webhook_listening_needs_secret'));

\echo '-- the one cross-tenant lookup, and its limits --'
SELECT helm_test.check('it takes a primary key, so it cannot enumerate',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'unifi_webhook_target'
     AND p.pronargs = 1 AND p.proargtypes[0] = 'uuid'::regtype) = 1);
SELECT helm_test.check('it hands back no controller API key',
  (SELECT pg_get_function_result(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'unifi_webhook_target') !~* 'api_key');
-- The real enumerator is still the worker's alone. 0430's guard said so for the
-- poll; adding a request-path receiver must not have quietly changed it.
SELECT helm_test.check('helm_app still cannot enumerate every tenant''s controllers',
  NOT has_function_privilege('helm_app', 'helm.unifi_poll_backlog(integer)', 'EXECUTE'));

\echo '-- the fast path obeys the slow path''s rules --'
SELECT helm_test.check('the webhook telemetry update names no user-owned column',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'apply_webhook_telemetry')
  !~ '(custom_name_enc|asset_tag|department|notes|maintenance_status|organization_id)\s*=');
-- The poll enumerates a site with the controller's own authority; an event
-- arrives over a path whose only check is a shared secret. Only one of those
-- should be able to put a new device into a client's documentation.
SELECT helm_test.check('...and it cannot create an asset at all',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'apply_webhook_telemetry')
  !~* 'INSERT\s+INTO\s+network_assets');

\echo '-- configuring the receiver is the same grant as the rest of the mapping --'
SELECT helm_test.check('setting the signing secret demands integration:network:manage',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'set_unifi_webhook_secret')
  LIKE '%integration:network:manage%');
SELECT helm_test.check('...and so does changing its state',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'set_unifi_webhook_state')
  LIKE '%integration:network:manage%');

\echo '-- a threat record keeps its addresses out of the audit log --'
-- audit_log.metadata is documented and trigger-enforced as non-sensitive, and
-- an IDS alert is nothing but sensitive: source address, destination address,
-- often a MAC. The audit row carries a DIGEST of the ciphertext instead, so the
-- hash chain commits to the detail without the audit log ever holding it.
SELECT helm_test.check('the threat recorder puts a digest in the audit metadata',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'record_network_threat')
  LIKE '%detail_sha256%');
SELECT helm_test.check('...and no address of any kind',
  (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'helm' AND p.proname = 'record_network_threat')
  !~ 'jsonb_build_object\([^)]*(source_ip|dest_ip|p_source_ip_enc|mac)');
SELECT helm_test.check('the detail itself is NOT NULL, so a threat cannot be recorded empty',
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'network_threat_event' AND column_name = 'detail_enc'
            AND is_nullable = 'NO'));
-- Severity and rule name stay queryable on purpose: they are how an operator
-- finds the event and they identify neither a person nor a machine.
SELECT helm_test.check('severity stays queryable',
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'network_threat_event' AND column_name = 'severity'
            AND data_type <> 'bytea'));
SELECT helm_test.check('a replayed alert cannot be recorded twice',
  EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indrelid = 'network_threat_event'::regclass AND i.indisunique
            AND pg_get_indexdef(i.indexrelid) LIKE '%external_event_id%'));

\echo '-- and the poll owes the receiver nothing --'
-- The property the whole design rests on. A poll that consulted webhook state
-- would make an optional, unguaranteed transport load-bearing.
SELECT helm_test.check('no polling function mentions webhooks',
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm'
      AND p.proname IN ('unifi_poll_backlog', 'claim_unifi_poll', 'finish_unifi_poll',
                        'upsert_network_asset', 'record_asset_ip')
      AND pg_get_functiondef(p.oid) ~* 'webhook'));

\echo '-- threat detail is tenant data like anything else --'
SELECT helm_test.check('network_threat_event carries RLS, forced',
  NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'network_threat_event'
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)));

-- Behavioural, because the catalogue check proves the switch is on and says
-- nothing about the policy being right.
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
INSERT INTO network_threat_event (
  tenant_id, organization_id, audit_event_uid, severity, signature,
  data_key_id, detail_enc)
VALUES (
  :t1, :t1_acme, gen_random_uuid(), 'critical', 'ET MALWARE probe',
  (SELECT id FROM tenant_data_key WHERE tenant_id = :t1 AND status = 'active' LIMIT 1),
  decode(repeat('ab', 40), 'hex'));
SELECT helm_test.check('the writing tenant sees its own threat record',
  (SELECT count(*) FROM network_threat_event WHERE signature = 'ET MALWARE probe') = 1);

SELECT helm_test.ctx(:t2, :u_admin2);
SELECT helm_test.check('the other tenant cannot see it',
  NOT EXISTS (SELECT 1 FROM network_threat_event WHERE signature = 'ET MALWARE probe'));
SELECT helm_test.check('...nor count it',
  (SELECT count(*) FROM network_threat_event) = 0);
ROLLBACK;

\echo ''
\echo '== All security assertions passed =='

