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
\echo '== Tamper detection verified =='
