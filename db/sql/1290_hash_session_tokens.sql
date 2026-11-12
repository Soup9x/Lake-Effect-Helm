-- =============================================================================
-- 1290 — auth_session holds a hash of each session token, not the token
-- =============================================================================
--
-- auth_session.session_token held the value the browser's cookie carries. So a
-- copy of the table (a backup, a restored dump, anybody with SQL access to the
-- auth tables) was a list of live sessions, each one a cookie away from being
-- somebody signed in. API tokens, reset codes and board links were already
-- stored as hashes; this was the one bearer credential that was not, and the
-- security model listed it as a known limitation (§7.6).
--
-- From here the column holds sha256(token) in hex, 64 characters. The cookie
-- still carries the token. The application hashes it before every statement
-- that names this column (storedSessionToken() in src/lib/auth/session-cookie.ts,
-- and the Auth.js adapter is wrapped to do the same), so nothing below the
-- application ever sees a token again.
--
-- EXISTING SESSIONS SURVIVE. The rows already here are hashed in place, so a
-- person signed in before this migration is still signed in after it: their
-- cookie's token hashes to the value their row now holds.
--
-- The column keeps its name because the Auth.js adapter addresses it by that
-- name. helm.create_local_session and helm.stamp_session_method take the
-- stored value in their p_session_token argument without change: both only
-- compare or insert it, and the length check in create_local_session (32 or
-- more) holds for a 64-character hash.
--
-- helm.session_ref() is the handle the account page shows and revokes by: the
-- first 32 hex characters of sha256(token). It was computed from the token;
-- the column now IS that hash, so the handle is its first 32 characters and
-- every existing handle is unchanged.
-- =============================================================================

SET search_path = public, extensions;

-- A token is 43 base64url characters (local sign-in) or a UUID (Auth.js),
-- never 64 lowercase hex, so the guard only keeps a second run from hashing a
-- hash.
UPDATE auth_session
SET session_token = encode(sha256(convert_to(session_token, 'UTF8')), 'hex')
WHERE session_token !~ '^[0-9a-f]{64}$';

ALTER TABLE auth_session
  ADD CONSTRAINT auth_session_token_is_hash CHECK (session_token ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN auth_session.session_token IS
  'sha256 of the session token, hex (1290). The token itself exists only in '
  'the browser''s cookie.';

CREATE OR REPLACE FUNCTION helm.session_ref(p_session_token text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  SELECT substr(p_session_token, 1, 32);
$$;

COMMENT ON FUNCTION helm.session_ref(text) IS
  'The public handle for a session: the first 32 characters of the stored '
  'hash (1290). Takes auth_session.session_token as stored.';
