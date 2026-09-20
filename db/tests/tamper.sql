-- =============================================================================
-- db/tests/tamper.sql — does the hash chain actually detect tampering?
--
-- Run as a SUPERUSER, deliberately. A superuser bypasses RLS, owns the tables,
-- and can switch off triggers with session_replication_role. That is precisely
-- the adversary the chain exists to catch: someone who CAN edit history, whose
-- edit must not go unnoticed.
--
-- Each case is rolled back, so the fixture database stays usable.
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\set t1       '''11111111-1111-1111-1111-111111111111'''
\set u_admin1 '''1b000000-0000-0000-0000-000000000001'''

\echo ''
\echo '== Baseline =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('chain is intact before tampering',
  (SELECT is_intact FROM helm.verify_audit_chain(:t1)));
SELECT helm_test.check('there is history to tamper with',
  (SELECT verified_rows FROM helm.verify_audit_chain(:t1)) >= 5);
ROLLBACK;

\echo ''
\echo '== Case 1: edit the content of a historical row =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
-- The immutability trigger would stop this; a superuser can switch it off.
SET session_replication_role = replica;
UPDATE audit_log
SET reason = 'routine check'
WHERE tenant_id = :t1 AND action = 'secret.revealed'
  AND chain_seq = (SELECT min(chain_seq) FROM audit_log
                   WHERE tenant_id = :t1 AND action = 'secret.revealed');
SET session_replication_role = origin;

SELECT helm_test.check('the edit itself succeeded (superuser can write)',
  EXISTS (SELECT 1 FROM audit_log WHERE tenant_id = :t1 AND reason = 'routine check'));
SELECT helm_test.check('...but the chain now reports a break',
  (SELECT NOT is_intact FROM helm.verify_audit_chain(:t1)));
SELECT helm_test.check('the break is diagnosed as a modified row',
  (SELECT detail FROM helm.verify_audit_chain(:t1))
  = 'row_hash does not match the row contents — this row was modified');
SELECT helm_test.check('the verifier names the exact event',
  (SELECT broken_event_uid FROM helm.verify_audit_chain(:t1)) IS NOT NULL);
ROLLBACK;

\echo ''
\echo '== Case 2: delete a historical row =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SET session_replication_role = replica;
DELETE FROM audit_log
WHERE tenant_id = :t1
  AND chain_seq = (SELECT min(chain_seq) + 1 FROM audit_log WHERE tenant_id = :t1);
SET session_replication_role = origin;

SELECT helm_test.check('deletion breaks the chain',
  (SELECT NOT is_intact FROM helm.verify_audit_chain(:t1)));
SELECT helm_test.check('the break is diagnosed as a sequence gap',
  (SELECT detail FROM helm.verify_audit_chain(:t1)) LIKE 'sequence gap%');
ROLLBACK;

\echo ''
\echo '== Case 3: forge a replacement row with a recomputed hash =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SET session_replication_role = replica;
-- The sophisticated attack: edit the row AND recompute its hash so the row is
-- internally consistent. Done as two statements so the second one hashes the
-- already-edited row via its whole-row reference.
UPDATE audit_log a
SET reason = 'nothing to see here'
WHERE a.tenant_id = :t1
  AND a.chain_seq = (SELECT min(chain_seq) FROM audit_log WHERE tenant_id = :t1);

UPDATE audit_log a
SET row_hash = digest(a.prev_hash || helm.audit_canonical_form(a), 'sha256')
WHERE a.tenant_id = :t1
  AND a.chain_seq = (SELECT min(chain_seq) FROM audit_log WHERE tenant_id = :t1);
SET session_replication_role = origin;

-- The forged row now hashes correctly on its own terms...
SELECT helm_test.check('the forged row is internally self-consistent',
  (SELECT a.row_hash = digest(a.prev_hash || helm.audit_canonical_form(a), 'sha256')
   FROM audit_log a WHERE a.tenant_id = :t1
     AND a.chain_seq = (SELECT min(chain_seq) FROM audit_log WHERE tenant_id = :t1)));

SELECT helm_test.check('a re-hashed forgery is still detected',
  (SELECT NOT is_intact FROM helm.verify_audit_chain(:t1)));
SELECT helm_test.check('detected because the following row''s prev_hash no longer matches',
  (SELECT detail FROM helm.verify_audit_chain(:t1))
  = 'prev_hash does not match the preceding row_hash');
ROLLBACK;

\echo ''
\echo '== Case 4: the chain head is the external anchor point =='
BEGIN;
SELECT helm_test.ctx(:t1, :u_admin1);
SELECT helm_test.check('the head hash equals the last row''s row_hash',
  (SELECT h.head_hash FROM audit_chain_head h WHERE h.tenant_id = :t1)
  = (SELECT a.row_hash FROM audit_log a WHERE a.tenant_id = :t1
     ORDER BY a.chain_seq DESC LIMIT 1));
SELECT helm_test.check('the head sequence equals the row count',
  (SELECT h.chain_seq FROM audit_chain_head h WHERE h.tenant_id = :t1)
  = (SELECT count(*) FROM audit_log a WHERE a.tenant_id = :t1));
ROLLBACK;

\echo ''
\echo '== Case 5: a later migration adds a tenant-scoped table and forgets RLS =='
--
-- This is the failure the catalogue backstop exists for, and it is not
-- hypothetical: radius_config (0360), oidc_provider (0410) and
-- notification_cursor (0420) each arrived carrying tenant_id with RLS switched
-- off, and every check in the project stayed green for months. 0200's DO block
-- could not see them — it ran once, before those tables existed — and nothing
-- re-asked the question afterwards. 0550 closed the three; this is what stops
-- the fourth.
--
-- Here rather than in security.sql because creating a table is the whole test,
-- and helm_app holds no CREATE on schema public. Migrations do run as a role
-- that can, which is precisely how the gap opened.
--
-- Everything is rolled back, so the fixture database is untouched.
BEGIN;
SELECT helm_test.check('the catalogue is clean to begin with',
  NOT EXISTS (SELECT 1 FROM helm_test.rls_catalogue_gaps()));

CREATE TABLE public.forgotten_settings (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  setting   text NOT NULL
);

SELECT helm_test.check('a new tenant-scoped table with RLS off is reported',
  EXISTS (SELECT 1 FROM helm_test.rls_catalogue_gaps()
          WHERE table_name = 'forgotten_settings' AND gap = 'RLS disabled'));

-- Half-fixing it is still a gap, and the quieter one. Without FORCE the table
-- OWNER is exempt from its own policies — and every SECURITY DEFINER function
-- in this schema runs as an owner, so an un-FORCEd table has no row security
-- on the exact path the application uses.
ALTER TABLE public.forgotten_settings ENABLE ROW LEVEL SECURITY;
SELECT helm_test.check('enabling without FORCE is still reported',
  EXISTS (SELECT 1 FROM helm_test.rls_catalogue_gaps()
          WHERE table_name = 'forgotten_settings' AND gap = 'RLS enabled but not FORCEd'));

-- Enforced with no policy denies everything for everyone, which is safe and
-- still means nobody decided what the rule should be.
ALTER TABLE public.forgotten_settings FORCE ROW LEVEL SECURITY;
SELECT helm_test.check('...and so is an enforced table with no policy at all',
  EXISTS (SELECT 1 FROM helm_test.rls_catalogue_gaps()
          WHERE table_name = 'forgotten_settings'
            AND gap = 'RLS enforced but the table has no policy at all'));

-- Wired up the way every other tenant table is, it disappears from the report.
-- A check that never goes green is a check people learn to ignore.
SELECT helm.apply_tenant_rls('forgotten_settings', false, 80, NULL);
SELECT helm_test.check('a table wired up the normal way is clean',
  NOT EXISTS (SELECT 1 FROM helm_test.rls_catalogue_gaps()
              WHERE table_name = 'forgotten_settings'));
SELECT helm_test.check('...and the whole catalogue is clean again',
  NOT EXISTS (SELECT 1 FROM helm_test.rls_catalogue_gaps()));
ROLLBACK;

\echo ''
\echo '== Case 6: a policy appears on the ciphertext table =='
-- The inverse gap, and the dangerous direction. secret_version has RLS enabled
-- and deliberately NO policy, so direct reads return nothing for every role
-- forever and ciphertext is reachable only through helm.reveal_secret(), which
-- writes the audit row in the same transaction. A permissive SELECT policy here
-- would turn "every secret read is audited" back into a promise about
-- application code — and would look, to a reviewer, exactly like somebody
-- finally wiring up a table that was missing one.
BEGIN;
SELECT helm_test.check('secret_version has no policy to begin with',
  NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.secret_version'::regclass));

CREATE POLICY tamper_probe ON secret_version FOR SELECT USING (true);

SELECT helm_test.check('a policy appearing on it is reported',
  EXISTS (SELECT 1 FROM helm_test.rls_catalogue_gaps()
          WHERE table_name = 'secret_version'
            AND gap = 'deny-all by design, but a policy has appeared on it'));
ROLLBACK;

\echo ''
\echo '== Case 7: 0550 is the layer, not a claim about one =='
-- The three tables have always been protected by grants. The question this
-- answers is whether row security now ALSO stands behind those grants, and it
-- is answered by switching RLS off inside a rolled-back transaction and
-- watching the same read succeed.
BEGIN;
INSERT INTO notification_cursor (tenant_id, last_chain_seq)
VALUES (:t1, 3)
ON CONFLICT (tenant_id) DO UPDATE SET last_chain_seq = 3;

INSERT INTO radius_config (tenant_id, enabled, host, wrap_provider, kek_id, wrapped_dek,
                           secret_ciphertext, secret_nonce, secret_tag, secret_aad)
VALUES (:t1, true, 'radius.tamper.test', 'test', 'k1',
        decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 24), 'hex'),
        decode(repeat('01', 12), 'hex'), decode(repeat('02', 16), 'hex'), 'tamper-aad')
ON CONFLICT (tenant_id) DO UPDATE SET host = 'radius.tamper.test';

-- helm_worker holds SELECT on notification_cursor and no session context, so
-- the policy is the only thing standing between it and every tenant's cursor.
SET ROLE helm_worker;
SELECT helm_test.check('the worker''s direct read of the cursor returns nothing',
  (SELECT count(*) FROM notification_cursor) = 0);
RESET ROLE;

ALTER TABLE notification_cursor DISABLE ROW LEVEL SECURITY;
SET ROLE helm_worker;
SELECT helm_test.check('...and with RLS off it would have seen the row, so that WAS the policy',
  (SELECT count(*) FROM notification_cursor) = 1);
RESET ROLE;
ALTER TABLE notification_cursor ENABLE ROW LEVEL SECURITY;

-- The definer path is untouched, which is the thing that had to stay true.
-- helm_auth cannot even evaluate the policy — it holds no EXECUTE on
-- helm.current_tenant_id() — so a direct read raises rather than returning
-- rows. Through the function it owns nothing changes.
SET ROLE helm_auth;
SELECT helm_test.check_raises('helm_auth''s direct read of radius_config is refused',
  $$SELECT count(*) FROM radius_config$$);
SELECT helm_test.check('...but the SECURITY DEFINER reader still returns the row',
  (SELECT count(*) FROM helm.radius_config_for_tenant(:t1)) = 1);
RESET ROLE;
ROLLBACK;

\echo ''
\echo '== Tamper detection verified =='
