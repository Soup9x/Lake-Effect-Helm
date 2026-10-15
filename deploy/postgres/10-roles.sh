#!/bin/sh
# =============================================================================
# Create Helm's runtime database roles, with passwords.
#
# Runs once, as the superuser, on an empty data directory — before any
# migration. That ordering matters: 0000_bootstrap.sql creates these roles
# WITHOUT passwords if they are absent, which is the right default for a
# managed Postgres where authentication is IAM or certificate based, and
# useless here where the application connects with a password.
#
# The attributes must match 0000_bootstrap.sql exactly. NOBYPASSRLS is the
# load-bearing one: a role with BYPASSRLS silently disables every policy in the
# schema, so this script asserts it at the end rather than trusting the DDL
# above to have been read.
# =============================================================================
set -eu

# Passwords go in as psql variables and are quoted by psql (:'name'), not
# spliced into the SQL text: init-secrets.sh generates hex, but an operator who
# sets one by hand with a quote in it would otherwise break this script or
# inject into it.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pw_app="${HELM_DB_PASSWORD_APP}" \
  -v pw_auth="${HELM_DB_PASSWORD_AUTH}" \
  -v pw_key_admin="${HELM_DB_PASSWORD_KEY_ADMIN}" \
  -v pw_auditor="${HELM_DB_PASSWORD_AUDITOR}" \
  -v pw_worker="${HELM_DB_PASSWORD_WORKER}" <<-SQL
	-- helm_migrator is NOT created here. Migrations run as the superuser (see
	-- the migrate service in docker-compose.yml), and a login role with no
	-- password and no purpose is one more thing to have to think about.

	CREATE ROLE helm_app        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
	  PASSWORD :'pw_app';
	CREATE ROLE helm_auth       LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
	  PASSWORD :'pw_auth';
	CREATE ROLE helm_key_admin  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
	  PASSWORD :'pw_key_admin';
	CREATE ROLE helm_auditor    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
	  PASSWORD :'pw_auditor';

	-- helm_worker is granted membership in helm_app by 0290_worker_identities.
	-- Created here only so it has a password to connect with.
	CREATE ROLE helm_worker     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
	  PASSWORD :'pw_worker';

	-- Asserted rather than assumed. If a future edit to this file drops
	-- NOBYPASSRLS from one line, the container fails to initialise instead of
	-- coming up with tenant isolation quietly switched off.
	DO \$guard\$
	DECLARE
	  v_bad text;
	BEGIN
	  SELECT string_agg(rolname, ', ') INTO v_bad
	  FROM pg_roles
	  WHERE rolname LIKE 'helm\_%'
	    AND (rolsuper OR rolbypassrls OR rolcreaterole);

	  IF v_bad IS NOT NULL THEN
	    RAISE EXCEPTION 'helm: role(s) % hold superuser, BYPASSRLS or CREATEROLE', v_bad;
	  END IF;
	END
	\$guard\$;
SQL

echo "helm: created 5 runtime roles"
