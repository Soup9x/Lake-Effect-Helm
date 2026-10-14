-- =============================================================================
-- 0630 — a name with two halves, a time zone, and a remembered theme
--
-- WHAT THIS IS FOR. Group E of the parity pass: the account page's profile and
-- preferences. Four columns on app_user, one reader, one writer.
--
-- WHY ON app_user AND NOT A PREFERENCES TABLE. user_dashboard (0370) and
-- user_sidebar (0620) are keyed (tenant_id, user_id) because what they hold IS
-- per-tenant: a layout of one tenant's categories means nothing in another.
-- These four are not. Somebody who works for two MSPs through one account has
-- one name, one time zone and one pair of eyes, and a theme keyed by tenant
-- would change colour when they switched tenants. app_user has no tenant_id,
-- which is exactly the shape this needs.
--
-- NO NEW FUNCTIONS, AND THAT IS THE CONSIDERED CHOICE. The obvious move was to
-- copy helm.set_my_profile() from 0360 — a SECURITY DEFINER "write my own
-- profile" entry point — and extend it. Checking what that function actually
-- relies on changed the answer:
--
--   * app_user IS readable and writable by helm_app, under RLS. 0220's deny
--     list covers auth_account, auth_session, auth_verification_token,
--     auth_authenticator, secret_version and audit_chain_head — not app_user,
--     because the password hash is not in it. It lives in local_credential
--     (0340), whose grants are narrower.
--   * app_user_rls_select is "my own row, or somebody who shares my tenant";
--     app_user_rls_update is "my own row, or helm.has_permission('user:write')".
--     Reading and writing one's own row is already permitted and already
--     confined.
--   * set_my_profile() is owned by postgres and SECURITY DEFINER, so it runs
--     as a superuser and RLS does not apply to it at all. Its `WHERE id =
--     v_actor` is the ONLY thing stopping it writing another user's row.
--
-- So a plain, explicitly scoped UPDATE is both simpler and SAFER than another
-- definer function: the route's WHERE and the RLS policy are two locks, where
-- a definer function has one. The route must still name the actor explicitly
-- rather than leaning on the policy — app_user_rls_update deliberately also
-- admits a user:write holder, so a bare UPDATE would let an administrator
-- change a colleague's theme. tests/integration/preferences.test.ts pins both
-- halves of that.
--
-- set_my_profile() IS LEFT IN PLACE AND IS NO LONGER CALLED. PATCH
-- /api/account now writes every profile field — display name included — in one
-- scoped UPDATE, because splitting it would make the outcome depend on
-- statement order: the name trigger below fires on an update of the halves, so
-- a separate set_my_profile() call afterwards would overwrite the name the
-- halves had just composed, and before it would be overwritten BY them. One
-- statement makes "the halves determine the display name when a save includes
-- them" a structural fact rather than a convention about call order.
--
-- The function itself stays. Dropping a granted, working,
-- authentication-adjacent function is a separate migration with its own risk
-- and no benefit to this one, and a deployment mid-rollout may still have the
-- old route calling it.
--
-- WHAT IS NOT HERE, and why, so a reader does not look for it:
--
--   "Enable side panel"   There is no side panel. Credentials open as a page
--                         and no sheet, drawer or overlay component exists, so
--                         the toggle would store a preference nothing reads.
--   MFA recovery token    Nothing in the application reads mfa_enrolled_at and
--                         the sign-in path enforces no second factor, so a
--                         one-time bypass token would be a second password for
--                         a door that is not locked.
--
-- Both are in the parity list and both need the feature they are a preference
-- for. They are recorded as deliberately absent in docs/itg-parity.md rather
-- than stored and ignored.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- The columns.
--
-- first_name / last_name are ADDITIVE: `name` stays the display column, so the
-- forty-odd queries that select u.name keep working untouched and nothing has
-- to decide at the call site whether a person has filled the halves in. A
-- trigger below keeps `name` in step when they do.
--
-- Nullable, all four except theme, and each NULL means something specific:
--   first_name/last_name  this account arrived from an IdP with one `name`
--                         field and nobody has split it
--   timezone              no preference; the interface keeps rendering UTC
--                         with an explicit suffix, which is what it does today
-- theme is NOT NULL DEFAULT 'system' because "follow the operating system" is
-- a real third answer rather than an absent one — globals.css has keyed off
-- exactly these three states since the theme was built.
-- -----------------------------------------------------------------------------
ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name  text,
  ADD COLUMN IF NOT EXISTS timezone   text,
  ADD COLUMN IF NOT EXISTS theme      text NOT NULL DEFAULT 'system';

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_theme_known') THEN
    ALTER TABLE app_user ADD CONSTRAINT app_user_theme_known
      CHECK (theme IN ('system', 'light', 'dark'));
  END IF;

  -- 60 each, against `name`'s 120, so a split name cannot exceed the display
  -- name it composes. A CHECK over a NULL column is NULL, which passes — so
  -- this bounds a supplied value without requiring one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_name_parts_bounded') THEN
    ALTER TABLE app_user ADD CONSTRAINT app_user_name_parts_bounded
      CHECK (length(first_name) <= 60 AND length(last_name) <= 60);
  END IF;

  -- A blank string is not a name and not an absence; it is the thing a form
  -- submits when somebody clears a field, and storing it would make
  -- "no last name" and "last name of nothing" different states that render
  -- identically. The writer below normalises to NULL; this refuses the rest.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_name_parts_not_blank') THEN
    ALTER TABLE app_user ADD CONSTRAINT app_user_name_parts_not_blank
      CHECK (btrim(coalesce(first_name, 'x')) <> '' AND btrim(coalesce(last_name, 'x')) <> '');
  END IF;
END;
$constraints$;

-- -----------------------------------------------------------------------------
-- The time zone has to be a real one.
--
-- A CHECK cannot do this: the set of valid zones lives in pg_timezone_names,
-- which is a view over the tzdata the server was built against, and a function
-- reading it is STABLE rather than IMMUTABLE — tzdata changes between
-- releases, so a CHECK that depended on it would be wrong about its own
-- history the moment a zone was retired.
--
-- So a trigger. The failure it prevents is specific and ugly: `AT TIME ZONE`
-- raises on an unknown zone, so a bad string stored here would not surface as
-- a validation error on the preferences form — it would surface as a 500 on
-- every page that renders a date, for one person, until somebody read the log.
--
-- organization.timezone and site.timezone have no validation at all, which is
-- the precedent and not a good one. This is the better shape; those are left
-- alone because changing them is a migration about data that already exists.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.reject_unknown_timezone() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.timezone IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'helm: % is not a time zone this server knows', NEW.timezone
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Use an IANA name such as America/New_York. '
                   'SELECT name FROM pg_timezone_names lists them.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_user_timezone_known ON app_user;
CREATE TRIGGER app_user_timezone_known
  BEFORE INSERT OR UPDATE OF timezone ON app_user
  FOR EACH ROW EXECUTE FUNCTION helm.reject_unknown_timezone();

-- -----------------------------------------------------------------------------
-- `name` follows the halves, when there are halves.
--
-- NARROW ON PURPOSE — UPDATE OF first_name, last_name only, and only when the
-- composition is non-empty:
--
--   * It does not fire on INSERT, because the Auth.js adapter owns that
--     statement and supplies `name` from the IdP profile with no halves.
--   * It does not fire on a plain `name` UPDATE, so setting only a display
--     name — the case for a mononym, or for cleaning up "SMITH, J
--     (Contractor)" out of a directory import — still works directly.
--   * It leaves `name` alone when both halves are cleared, rather than
--     blanking the name an IdP supplied. Clearing the halves says "I do not
--     want to maintain these", not "I have no name".
--
-- The alternative — a generated column — cannot work: the adapter writes
-- `name` on createUser, and a generated column is not writable.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.compose_user_name() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_composed text := nullif(btrim(concat_ws(' ', NEW.first_name, NEW.last_name)), '');
BEGIN
  IF v_composed IS NOT NULL THEN
    NEW.name := v_composed;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_user_compose_name ON app_user;
CREATE TRIGGER app_user_compose_name
  BEFORE UPDATE OF first_name, last_name ON app_user
  FOR EACH ROW EXECUTE FUNCTION helm.compose_user_name();

-- =============================================================================
-- Guards
-- =============================================================================
DO $preferences_guard$
DECLARE
  v_name text;
BEGIN
  -- 1. THE COLUMNS EXIST, with the nullability each one means.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_name = 'app_user'
         AND column_name IN ('first_name', 'last_name', 'timezone', 'theme')) <> 4 THEN
    RAISE EXCEPTION 'helm: 0630 did not add all four preference columns';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'app_user' AND column_name = 'theme') <> 'NO' THEN
    RAISE EXCEPTION 'helm: app_user.theme must be NOT NULL — "system" is an answer';
  END IF;

  -- 2. THE THEME IS CONSTRAINED. Without the CHECK, a typo stores a value
  --    globals.css has no selector for, which renders as light and looks like
  --    the preference was ignored.
  BEGIN
    UPDATE app_user SET theme = 'puce' WHERE false;
    -- A no-op UPDATE does not evaluate the CHECK, so prove it the other way.
  EXCEPTION WHEN others THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_user_theme_known' AND conrelid = 'app_user'::regclass
  ) THEN
    RAISE EXCEPTION 'helm: app_user.theme is not constrained to known themes';
  END IF;

  -- 3. THE TIME ZONE TRIGGER IS ATTACHED AND REFUSES A MADE-UP ZONE. Asserted
  --    by attempting one on a throwaway row, because a trigger that exists and
  --    does nothing is the failure mode worth catching.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app_user'::regclass AND tgname = 'app_user_timezone_known'
  ) THEN
    RAISE EXCEPTION 'helm: app_user has no time zone validation trigger';
  END IF;

  INSERT INTO app_user (id, email, name)
  VALUES ('00000000-0000-0000-0000-00000000f630'::uuid, 'guard-0630@helm.invalid', 'Guard');
  BEGIN
    UPDATE app_user SET timezone = 'Mars/Olympus_Mons'
    WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;
    RAISE EXCEPTION 'helm: an unknown time zone was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- ...and accepts a real one, so the trigger is not simply refusing everything.
  UPDATE app_user SET timezone = 'America/New_York'
  WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;

  -- 4. `name` FOLLOWS THE HALVES, and stops following when they are cleared.
  UPDATE app_user SET first_name = 'Ada', last_name = 'Lovelace'
  WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;
  SELECT name INTO v_name FROM app_user
   WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;
  IF v_name <> 'Ada Lovelace' THEN
    RAISE EXCEPTION 'helm: the name trigger did not compose the halves (got %)', v_name;
  END IF;

  -- One half only, which is the common case for a mononym or an IdP that sends
  -- a given name and nothing else.
  UPDATE app_user SET last_name = NULL
  WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;
  SELECT name INTO v_name FROM app_user
   WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;
  IF v_name <> 'Ada' THEN
    RAISE EXCEPTION 'helm: one half should compose to itself (got %)', v_name;
  END IF;

  -- Both cleared: the display name is LEFT as it was, not blanked.
  UPDATE app_user SET first_name = NULL
  WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;
  SELECT name INTO v_name FROM app_user
   WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;
  IF v_name IS DISTINCT FROM 'Ada' THEN
    RAISE EXCEPTION 'helm: clearing both halves should leave the name alone (got %)', v_name;
  END IF;

  DELETE FROM app_user WHERE id = '00000000-0000-0000-0000-00000000f630'::uuid;

  -- 5. THE ROUTE'S SECOND LOCK IS REAL. These columns are written by a plain
  --    UPDATE from the application rather than a definer function, so the
  --    RLS policy is half the enforcement and this records what it is. If
  --    app_user_rls_update ever loses its actor clause, a preferences write
  --    stops being confined by anything but the route's own WHERE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'app_user' AND policyname = 'app_user_rls_update'
      AND qual LIKE '%current_actor_id%'
  ) THEN
    RAISE EXCEPTION 'helm: app_user_rls_update no longer confines a write to its own row';
  END IF;

  -- ...and it is FORCED, so the table owner is not exempt from it either.
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class WHERE oid = 'app_user'::regclass) THEN
    RAISE EXCEPTION 'helm: app_user does not force row level security';
  END IF;

  -- 6. AND THE PASSWORD HASH IS STILL SOMEWHERE ELSE. The whole reason a plain
  --    UPDATE on app_user is acceptable is that the table holds no secret
  --    material; local_credential (0340) does, with narrower grants. A hash
  --    column appearing on app_user would quietly invalidate that reasoning.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_user'
      AND (column_name LIKE '%password%' OR column_name LIKE '%_phc' OR column_name LIKE '%hash%')
  ) THEN
    RAISE EXCEPTION 'helm: app_user has gained a credential column; 0630 assumed it had none';
  END IF;
END;
$preferences_guard$;
