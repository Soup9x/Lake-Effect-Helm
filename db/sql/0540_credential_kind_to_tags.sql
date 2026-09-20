-- =============================================================================
-- 0540 — "Kind" stops being a question, and becomes a starting tag
--
-- Storing a credential asked for a Kind from a fixed dropdown of ten. It is a
-- taxonomy the product imposed rather than one anybody asked for, and it does
-- not survive contact with what an MSP actually stores: "Account type" is
-- meaningless on a licence key, a username is meaningless on a certificate, and
-- the list has no room for whatever the tenth thing is.
--
-- Freeform tags replace it in the interface. secret.kind STAYS, because it has
-- real consumers — helm.reveal_secret() returns it, the export renderer prints
-- it, and credential.totp_secret_kind is a GENERATED column pinned to
-- 'totp_seed'. What changes is that nobody is asked for it.
--
-- 'generic', NOT 'other'. The brief says new credentials should default to
-- 'other'; secret_kind has no such value. Its word for exactly this is
-- 'generic', and src/components/new-secret-form.tsx already renders that option
-- as "Other" — so the intent is already spelled 'generic' everywhere in this
-- schema. Adding a real 'other' value would mean an ALTER TYPE in its own
-- migration file (a new enum value cannot be USED in the transaction that adds
-- it, and db/migrate.ts runs one transaction per file) to gain a synonym for a
-- value that already exists.
--
-- THE TWO SYSTEMS ARE INDEPENDENT, and this file is the only place they ever
-- touch. The backfill below copies kind into a tag ONCE. Nothing reads a tag to
-- infer a kind, nothing writes a kind from a tag, and the guard at the bottom
-- fails the migration if a trigger is ever added that does. Tagging a
-- credential must never have a side effect on what reveal or export do with it
-- — a tag is a label somebody chose, and kind is a fact about the material.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. The default, at the database level, so a caller that omits kind gets one
--    without the application deciding what it is.
-- -----------------------------------------------------------------------------
ALTER TABLE secret ALTER COLUMN kind SET DEFAULT 'generic'::secret_kind;

COMMENT ON COLUMN secret.kind IS
  'What the material IS, for the reveal and export paths. No longer asked for '
  'at creation — new secrets default to generic. Never derived from tags: '
  'asset_node.tags is a label somebody chose, this is a fact about the value.';

-- -----------------------------------------------------------------------------
-- 2. The one-time backfill: every existing credential keeps its categorisation
--    as a tag on its node.
--
--    asset_node.tags, not a new column — a credential IS an asset_node, the
--    column has been there since 0050, /api/bulk/tags already targets it and
--    TagEditor already edits it. The audit found the tagging infrastructure
--    was entirely present and only the credential form had not used it.
--
--    Tags are stored lowercased, deduplicated and sorted (normaliseTags in
--    lib/bulk/service.ts). secret_kind values are already lowercase snake_case,
--    so they are valid tags unchanged — 'ssh_key' becomes the tag "ssh_key".
--
--    EVERY kind, including 'password'. Being selective would mean this file
--    deciding which of somebody's categorisations were worth keeping; an
--    operator who does not want "password" on four hundred rows can remove it
--    with the bulk toolbar in one action, and cannot recover it if this file
--    drops it.
-- -----------------------------------------------------------------------------
UPDATE asset_node n
   SET tags = (
         SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}'::text[])
         FROM unnest(n.tags || ARRAY[s.kind::text]) AS t
       ),
       updated_at = now()
  FROM credential c
  JOIN secret s ON s.id = c.secret_id
 WHERE n.id = c.id
   AND n.node_type = 'credential'
   -- Idempotent: re-running adds nothing, and the array_agg above would not
   -- change a row that already carries the tag anyway.
   AND NOT (s.kind::text = ANY (n.tags));

-- =============================================================================
-- Guards
-- =============================================================================
DO $kind_tag_guard$
DECLARE
  v_missing bigint;
  v_bad     text;
BEGIN
  -- 1. THE DEFAULT IS THERE. Without it, POST /api/secrets omitting kind hits
  --    a NOT NULL violation, which is a 500 on the ordinary path.
  IF (SELECT pg_get_expr(d.adbin, d.adrelid)
        FROM pg_attribute a JOIN pg_attrdef d
          ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'secret'::regclass AND a.attname = 'kind') IS NULL THEN
    RAISE EXCEPTION 'helm: secret.kind has no default, so a caller must still supply one';
  END IF;

  -- 2. AND IT IS STILL NOT NULL. A default is a convenience; the column being
  --    required is what the reveal and export paths rely on.
  IF NOT (SELECT attnotnull FROM pg_attribute
           WHERE attrelid = 'secret'::regclass AND attname = 'kind') THEN
    RAISE EXCEPTION 'helm: secret.kind became nullable';
  END IF;

  -- 3. THE BACKFILL REACHED EVERY CREDENTIAL. The assertion that turns "the
  --    UPDATE ran" into "no categorisation was lost".
  SELECT count(*) INTO v_missing
  FROM credential c
  JOIN asset_node n ON n.id = c.id
  JOIN secret s ON s.id = c.secret_id
  WHERE NOT (s.kind::text = ANY (n.tags));
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'helm: % credentials did not receive their kind as a tag', v_missing;
  END IF;

  -- 4. THE TOTP GENERATED COLUMN IS UNTOUCHED. credential.totp_secret_kind is
  --    pinned to 'totp_seed' and is one of the consumers that made keeping the
  --    column necessary; a default on secret.kind must not have disturbed it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'credential'::regclass AND attname = 'totp_secret_kind'
      AND attgenerated <> ''
  ) THEN
    RAISE EXCEPTION 'helm: credential.totp_secret_kind is no longer a generated column';
  END IF;

  -- 5. NOTHING DERIVES ONE FROM THE OTHER. The independence the brief asked
  --    for, asserted rather than promised: no trigger function on secret or
  --    asset_node may mention both a kind and tags, in either direction.
  SELECT string_agg(DISTINCT p.proname, ', ') INTO v_bad
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal
    AND c.relname IN ('secret', 'asset_node', 'credential')
    AND pg_get_functiondef(p.oid) ~ '\mkind\M'
    AND pg_get_functiondef(p.oid) ~ '\mtags\M'
    -- The search projector legitimately reads both: it copies tags into the
    -- index and derives a search `kind` (client / asset / credential) that has
    -- nothing to do with secret_kind. Named so the exemption is deliberate.
    AND p.proname NOT IN ('index_asset_node', 'index_organization', 'index_site',
                          'index_contact', 'index_attachment', 'index_flexible_record');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'helm: % reads both kind and tags; a tag must never influence what reveal or export do', v_bad;
  END IF;
END;
$kind_tag_guard$;
