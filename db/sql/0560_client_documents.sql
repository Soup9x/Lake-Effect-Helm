-- =============================================================================
-- 0560 — per-client documents: a folder tree over the attachments that exist
--
-- WHY THERE IS NO documents TABLE IN HERE.
--
-- `attachment` (0130) already is this table. It carries tenant_id and a NOT
-- NULL organization_id with a NULLABLE node_id, so a file that belongs to a
-- client rather than to one firewall has always been expressible. It already
-- carries is_internal_only, and since 0390 its four policies consult
-- helm.internal_visible() — the flag whose enforcement gaps this project has
-- had to close more than once. It already carries the envelope columns
-- (data_key_id, encryption_nonce), a content hash, a byte size, a unique
-- storage_key and deleted_at. helm.index_attachment() (0380) already projects
-- its filename into search_document, split on the punctuation filenames are
-- made of.
--
-- A second table would have duplicated every one of those and would have
-- needed its own copy of every future is_internal_only fix. The audit of that
-- flag in 0390 found the rule held in ONE of fifteen query paths; the way not
-- to repeat that is to have fewer things carrying the flag, not more.
--
-- So attachment gains three columns and the tree gets a table of its own,
-- because a folder is the one thing here that genuinely does not exist
-- anywhere in this schema and cannot be retrofitted onto a row that is a file.
--
-- WHAT A DOCUMENT IS, precisely: an attachment with is_document. It lives in
-- the client's document tree at folder_id (NULL means the top level of that
-- tree, not "no folder" — see the partial unique index). It is never also
-- hanging off an asset: a file documenting one firewall belongs on that
-- firewall, and a CHECK says so rather than a convention nobody can see.
--
-- WHERE THE BYTES GO: the local filesystem, under HELM_DOCUMENT_DIR, the same
-- way exports and passphrases already live under /var/lib/helm. 0130's comment
-- says "S3-compatible storage" and describes an intention this deployment
-- never had; src/lib/documents/storage.ts is what actually writes them, and it
-- reuses the export storage's sharded opaque keys and 0600 modes. The bytes
-- are AES-256-GCM under the tenant DEK before they reach the disk, with the
-- AAD binding a ciphertext to its tenant and its attachment id.
--
-- INTERNAL-ONLY IS INHERITED, and that is the substance of this migration
-- rather than a detail of it. A document inside an internal-only folder must
-- be hidden even when its own flag is false — otherwise a co-managed client
-- sees a file whose folder they cannot see, and search surfaces it. Two ways
-- to do that: walk the ancestor chain inside every policy, or make the flag
-- true on the row. The first needs a recursive CTE evaluated per row, under a
-- SECURITY DEFINER function because the walk would otherwise be filtered by
-- the very policy it is deciding. The second makes "is this visible" a plain
-- column test on every path that already exists — RLS, the search projector,
-- the export collector — which is exactly the property the 0390 audit said was
-- missing. So: an invariant, child.is_internal_only >= parent.is_internal_only,
-- maintained by trigger. Marking a folder internal marks everything under it.
-- Un-marking it does NOT un-mark them, because that is the direction where
-- being wrong exposes something.
--
-- DELETION FOLLOWS 0500. A document is archived before it can be deleted, and
-- deleting needs asset:delete, which sits strictly above the asset:write that
-- archiving needs and which no client-side role holds. A FOLDER must be empty
-- first — of documents and of subfolders, archived ones included — and that is
-- an ON DELETE RESTRICT rather than a rule in a route.
--
-- NO VERSIONING. Re-uploading a name that is already taken in that folder is
-- refused by a unique index; the caller renames or archives the old one. The
-- alternative, silently replacing, is version history with the history left
-- out — it destroys bytes somebody may still need and it cannot be undone.
-- =============================================================================
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- document_folder — the tree.
--
-- Per organisation, so two clients may both have a folder called "Contracts"
-- and neither can see the other's. parent_id NULL is the top level of one
-- client's tree; there is no root ROW, because a root row is a row somebody can
-- rename, move or delete and every operation would need to special-case it.
-- -----------------------------------------------------------------------------
CREATE TABLE document_folder (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  parent_id        uuid,

  name             text NOT NULL,
  is_internal_only boolean NOT NULL DEFAULT false,

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT document_folder_tenant_uk UNIQUE (id, tenant_id),
  -- Carries organization_id so a child folder, and a document, can be tied to
  -- the same client by a foreign key rather than by a check somebody has to
  -- remember to write.
  CONSTRAINT document_folder_org_uk UNIQUE (id, tenant_id, organization_id),

  CONSTRAINT document_folder_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: "delete this folder" must not silently take a
  -- subtree with it. Emptying it first is the confirmation.
  CONSTRAINT document_folder_parent_fk
    FOREIGN KEY (parent_id, tenant_id, organization_id)
    REFERENCES document_folder (id, tenant_id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT document_folder_not_self CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT document_folder_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT document_folder_name_bounded CHECK (length(name) <= 120),
  -- A name that is a path is a second, competing idea of where a folder is.
  CONSTRAINT document_folder_name_flat CHECK (name !~ '[/\\]'),
  -- Control characters render as nothing and make two folders look identical.
  CONSTRAINT document_folder_name_printable CHECK (name !~ '[\u0000-\u001f\u007f]')
);

-- Case-insensitive, because "Contracts" and "contracts" side by side in a tree
-- is a support call. NULLS NOT DISTINCT so the top level is a namespace like
-- any other — without it two top-level folders could share a name, since
-- parent_id is NULL for both and NULLs are distinct by default.
CREATE UNIQUE INDEX document_folder_sibling_name_uk
  ON document_folder (tenant_id, organization_id, parent_id, lower(name))
  NULLS NOT DISTINCT;

CREATE INDEX document_folder_parent_idx
  ON document_folder (tenant_id, organization_id, parent_id);

CREATE TRIGGER document_folder_touch BEFORE UPDATE ON document_folder
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

COMMENT ON TABLE document_folder IS
  'Per-client document folders, nested. Contents are attachment rows carrying '
  'is_document. is_internal_only is inherited downwards by trigger, so every '
  'visibility decision stays a plain column test.';

-- -----------------------------------------------------------------------------
-- attachment, extended.
-- -----------------------------------------------------------------------------
ALTER TABLE attachment ADD COLUMN folder_id   uuid;
ALTER TABLE attachment ADD COLUMN is_document boolean NOT NULL DEFAULT false;
ALTER TABLE attachment ADD COLUMN archived_at timestamptz;

ALTER TABLE attachment ADD CONSTRAINT attachment_folder_fk
  FOREIGN KEY (folder_id, tenant_id, organization_id)
  REFERENCES document_folder (id, tenant_id, organization_id) ON DELETE RESTRICT;

-- folder_id only means anything on a document, so it may not be set without
-- the flag. The converse is deliberately allowed: is_document with a NULL
-- folder_id is a document at the top level of the tree.
ALTER TABLE attachment ADD CONSTRAINT attachment_folder_is_document
  CHECK (folder_id IS NULL OR is_document);

-- A document is a standalone file in a client's tree; a file that documents one
-- asset belongs on that asset and appears under it. Letting a row be both makes
-- "where does this live" ambiguous on every screen that shows either.
ALTER TABLE attachment ADD CONSTRAINT attachment_document_not_node
  CHECK (NOT is_document OR node_id IS NULL);

-- One name per folder. Archived documents KEEP their name reserved — the row is
-- whole and one click from coming back, and a restore that collided with a
-- newer file of the same name would have to resolve it silently.
CREATE UNIQUE INDEX attachment_document_name_uk
  ON attachment (tenant_id, organization_id, folder_id, lower(filename))
  NULLS NOT DISTINCT
  WHERE is_document AND deleted_at IS NULL;

CREATE INDEX attachment_document_folder_idx
  ON attachment (tenant_id, organization_id, folder_id)
  WHERE is_document AND deleted_at IS NULL AND archived_at IS NULL;

COMMENT ON COLUMN attachment.folder_id IS
  'The document folder this file sits in. NULL on a document means the top '
  'level of that client''s tree, NOT "no folder".';
COMMENT ON COLUMN attachment.is_document IS
  'True for a standalone file in the client document tree, false for a file '
  'attached to an asset or site. A document never has a node_id.';
COMMENT ON COLUMN attachment.archived_at IS
  'Hidden from default views and out of the search index, fully readable, '
  'restorable. Required before helm.delete_document() will remove it, the same '
  'archive-first rail 0500 put in front of deleting a client or a credential.';

-- =============================================================================
-- The tree's shape: no cycles, bounded depth, one client.
-- =============================================================================

-- The names from the top level down to and including this folder.
--
-- SECURITY INVOKER, and safe to be, because of the inheritance invariant below:
-- a child is at least as internal as its parent, so a folder the caller can see
-- has an ancestor chain the caller can see. There is no case where this returns
-- a short path because RLS hid a link.
CREATE OR REPLACE FUNCTION helm.document_folder_path(p_folder_id uuid)
  RETURNS text[]
  LANGUAGE sql STABLE
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
  WITH RECURSIVE chain AS (
    SELECT f.id, f.parent_id, f.name, 1 AS depth
    FROM document_folder f
    WHERE f.id = p_folder_id
    UNION ALL
    SELECT p.id, p.parent_id, p.name, c.depth + 1
    FROM document_folder p
    JOIN chain c ON p.id = c.parent_id
    -- Belt and braces. The trigger below makes a cycle impossible; without a
    -- bound here a corrupted tree would hang a SELECT rather than raise.
    WHERE c.depth < 64
  )
  SELECT coalesce(array_agg(name ORDER BY depth DESC), ARRAY[]::text[]) FROM chain;
$$;

COMMENT ON FUNCTION helm.document_folder_path(uuid) IS
  'Folder names from the top level down to this one. Empty array for NULL, '
  'which is the top level itself.';

/**
 * Depth, and the reason there is a limit at all.
 *
 * Breadcrumbs stop being navigation past about six levels, and an unbounded
 * chain turns every path lookup into an unbounded walk. Sixteen is far past
 * anything a filing structure needs and small enough to stay cheap.
 */
CREATE OR REPLACE FUNCTION helm.document_folder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_cursor uuid := NEW.parent_id;
  v_depth  integer := 1;
  v_parent document_folder%ROWTYPE;
BEGIN
  WHILE v_cursor IS NOT NULL LOOP
    -- A folder cannot be moved inside itself or inside its own descendant.
    -- Without this the subtree detaches from the tree entirely: still in the
    -- table, reachable from nothing, invisible in every listing.
    IF v_cursor = NEW.id THEN
      RAISE EXCEPTION 'helm: a folder cannot be moved inside itself'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_parent FROM document_folder WHERE id = v_cursor;
    IF NOT FOUND THEN
      -- The foreign key has the final say; this only stops the walk.
      EXIT;
    END IF;

    v_depth := v_depth + 1;
    IF v_depth > 16 THEN
      RAISE EXCEPTION 'helm: document folders may not nest more than 16 deep'
        USING ERRCODE = 'check_violation';
    END IF;

    v_cursor := v_parent.parent_id;
  END LOOP;

  -- INHERITANCE, on the way in. A folder created or moved under an
  -- internal-only parent is internal-only, whatever the caller asked for.
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM document_folder WHERE id = NEW.parent_id;
    IF FOUND AND v_parent.is_internal_only THEN
      NEW.is_internal_only := true;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER document_folder_guard
  BEFORE INSERT OR UPDATE OF parent_id, is_internal_only ON document_folder
  FOR EACH ROW EXECUTE FUNCTION helm.document_folder_guard();

-- -----------------------------------------------------------------------------
-- Inheritance, on the way down.
--
-- Marking a folder internal marks everything already under it, folders and
-- documents alike, in one statement each rather than by letting the per-row
-- triggers chase the tree. helm.cascading_internal stops those triggers from
-- re-entering and walking subtrees this statement has already covered; it is
-- transaction-local, the same shape as the purge guard in 0520.
--
-- ONE DIRECTION ONLY. Clearing the flag on a parent does not clear it on its
-- children: a file somebody marked internal for its own reasons must not become
-- client-visible because an unrelated folder above it was reorganised. Getting
-- that wrong exposes something; getting the other direction wrong hides
-- something.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.document_folder_cascade() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_subtree uuid[];
BEGIN
  IF coalesce(current_setting('helm.cascading_internal', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF NOT NEW.is_internal_only THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_internal_only AND OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id THEN
    RETURN NULL;
  END IF;

  WITH RECURSIVE subtree AS (
    SELECT f.id FROM document_folder f WHERE f.parent_id = NEW.id
    UNION ALL
    SELECT c.id FROM document_folder c JOIN subtree s ON c.parent_id = s.id
  )
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_subtree FROM subtree;

  PERFORM set_config('helm.cascading_internal', 'on', true);

  IF array_length(v_subtree, 1) > 0 THEN
    UPDATE document_folder SET is_internal_only = true
    WHERE id = ANY(v_subtree) AND NOT is_internal_only;
  END IF;

  UPDATE attachment SET is_internal_only = true
  WHERE is_document
    AND NOT is_internal_only
    AND folder_id = ANY(array_append(v_subtree, NEW.id));

  PERFORM set_config('helm.cascading_internal', 'off', true);
  RETURN NULL;
END;
$$;

CREATE TRIGGER document_folder_cascade
  AFTER INSERT OR UPDATE OF parent_id, is_internal_only ON document_folder
  FOR EACH ROW EXECUTE FUNCTION helm.document_folder_cascade();

-- A document dropped into an internal-only folder is internal-only. Same rule,
-- applied from the file's side, so it holds for an INSERT the folder never
-- hears about.
CREATE OR REPLACE FUNCTION helm.attachment_folder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_folder document_folder%ROWTYPE;
BEGIN
  IF NOT NEW.is_document OR NEW.folder_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_folder FROM document_folder WHERE id = NEW.folder_id;
  IF FOUND AND v_folder.is_internal_only THEN
    NEW.is_internal_only := true;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER attachment_folder_guard
  BEFORE INSERT OR UPDATE OF folder_id, is_document, is_internal_only ON attachment
  FOR EACH ROW EXECUTE FUNCTION helm.attachment_folder_guard();

-- =============================================================================
-- Row-level security.
--
-- The generic builder, with the flag declared. Nothing bespoke: a document
-- folder is organisation-scoped documentation like a site or a note, rank 40 to
-- write, and the internal-only predicate is the same helm.internal_visible()
-- every other flagged table uses. attachment's own policies already carry it
-- and are left exactly as 0390 wrote them — that is the whole argument for
-- putting documents in attachment rather than beside it.
-- =============================================================================
SELECT helm.apply_tenant_rls('document_folder', true, 40, 'is_internal_only');

-- =============================================================================
-- Search.
--
-- Nobody remembers which folder the cabling diagram is in, and quite often not
-- the filename either — but they remember one of the two. So a document is
-- matched on its path as well as its name, and the path is what the result
-- shows underneath the title, because "acme-network.vsdx" appearing three times
-- is only useful if the rows say Contracts, Onboarding and Archive.
--
-- The projection is a function rather than trigger-body code because a folder
-- rename has to re-project every document beneath it, and two copies of this
-- would drift within a release.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.project_attachment(p_attachment_id uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_row   attachment%ROWTYPE;
  v_path  text[];
  v_terms text[];
BEGIN
  SELECT * INTO v_row FROM attachment WHERE id = p_attachment_id;

  -- Gone, retired, or archived. Archived documentation should not surface in a
  -- search for live work; the archive view is where it is meant to be found.
  -- 0490 established that for asset_node and this follows it.
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL OR v_row.archived_at IS NOT NULL THEN
    DELETE FROM search_document WHERE entity_type = 'attachment' AND entity_id = p_attachment_id;
    RETURN;
  END IF;

  v_path := CASE WHEN v_row.is_document THEN helm.document_folder_path(v_row.folder_id)
                 ELSE ARRAY[]::text[] END;

  -- The whole filename, its parts split on the punctuation filenames are
  -- actually made of, and every folder name on the way down.
  v_terms := ARRAY[v_row.filename]
          || string_to_array(regexp_replace(v_row.filename, '[._\-]+', ' ', 'g'), ' ')
          || v_path;

  INSERT INTO search_document (
    entity_type, entity_id, tenant_id, organization_id, node_id, kind,
    title, subtitle, identifiers, is_internal_only, client_visible, updated_at
  )
  VALUES (
    'attachment', v_row.id, v_row.tenant_id, v_row.organization_id, v_row.node_id, 'document',
    v_row.filename,
    CASE
      WHEN NOT v_row.is_document THEN v_row.content_type
      WHEN array_length(v_path, 1) > 0 THEN array_to_string(v_path, ' / ')
      ELSE 'Documents'
    END,
    helm.normalise_terms(v_terms),
    v_row.is_internal_only, NOT v_row.is_internal_only, now()
  )
  ON CONFLICT (entity_type, entity_id) DO UPDATE
  SET organization_id  = EXCLUDED.organization_id,
      node_id          = EXCLUDED.node_id,
      title            = EXCLUDED.title,
      subtitle         = EXCLUDED.subtitle,
      identifiers      = EXCLUDED.identifiers,
      is_internal_only = EXCLUDED.is_internal_only,
      client_visible   = EXCLUDED.client_visible,
      updated_at       = now();
END;
$$;

CREATE OR REPLACE FUNCTION helm.index_attachment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_document WHERE entity_type = 'attachment' AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  PERFORM helm.project_attachment(NEW.id);
  RETURN NEW;
END;
$$;

-- Recreated rather than left alone: a trigger's UPDATE OF column list cannot be
-- altered, and archived_at, folder_id and is_document all change what the index
-- should say.
DROP TRIGGER IF EXISTS attachment_search ON attachment;
CREATE TRIGGER attachment_search
  AFTER INSERT OR UPDATE OF filename, content_type, is_internal_only, deleted_at,
                            archived_at, organization_id, node_id, folder_id, is_document
  OR DELETE ON attachment
  FOR EACH ROW EXECUTE FUNCTION helm.index_attachment();

-- A folder rename or move changes the path of every document beneath it, and
-- the index has to hear about it. Statement-level would be cheaper; per-row is
-- what can name the subtree.
CREATE OR REPLACE FUNCTION helm.document_folder_reindex() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_document uuid;
BEGIN
  FOR v_document IN
    WITH RECURSIVE subtree AS (
      SELECT NEW.id AS id
      UNION ALL
      SELECT c.id FROM document_folder c JOIN subtree s ON c.parent_id = s.id
    )
    SELECT a.id FROM attachment a JOIN subtree s ON a.folder_id = s.id
    WHERE a.is_document AND a.deleted_at IS NULL
  LOOP
    PERFORM helm.project_attachment(v_document);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER document_folder_reindex
  AFTER UPDATE OF name, parent_id ON document_folder
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)
  EXECUTE FUNCTION helm.document_folder_reindex();

-- =============================================================================
-- Reading a document, and the audit row that goes with it.
--
-- A client's files are the same class of material as their credentials: an
-- install note with a PSK in it, a network diagram, a signed contract. So a
-- download is an audited event, recorded in the same transaction that hands
-- back the location of the bytes.
--
-- SECURITY DEFINER, and honest about what that does and does not buy. It is not
-- the wall helm.reveal_secret() is — the ciphertext lives on a filesystem, not
-- in a column helm_app cannot read — so somebody who reads attachment directly
-- can still find a storage_key. What it does buy is that the SUPPORTED path
-- cannot return one without writing the audit row, and that the visibility
-- rules are applied here rather than trusted to a route: being definer, it
-- bypasses RLS, so every check RLS would have made is made explicitly below.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.open_document(p_attachment_id uuid)
  RETURNS TABLE (
    ok               boolean,
    deny_reason      text,
    attachment_id    uuid,
    organization_id  uuid,
    filename         text,
    content_type     text,
    byte_size        bigint,
    storage_key      text,
    data_key_id      uuid,
    encryption_nonce bytea,
    content_sha256   bytea,
    audit_event_uid  uuid
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_doc attachment%ROWTYPE;
  v_uid uuid;
BEGIN
  SELECT * INTO v_doc FROM attachment
  WHERE id = p_attachment_id
    AND tenant_id = helm.require_tenant_id()
    AND is_document
    AND deleted_at IS NULL;

  -- Every clause RLS would have applied, applied by hand because this function
  -- is not subject to it. Out of scope, internal-only to a client actor, or
  -- simply absent all answer the same way: there is no such document. A
  -- distinguishable "exists but you may not" tells a client which folders the
  -- MSP keeps from them.
  IF NOT FOUND
     OR NOT helm.org_in_scope(v_doc.organization_id)
     OR NOT helm.internal_visible(v_doc.is_internal_only)
     OR NOT helm.has_permission('asset:read') THEN
    -- RETURNED, NOT RAISED, and that is the whole reason this reads oddly.
    -- helm.audit() writes a row; RAISE would roll it back, taking the record of
    -- the refusal with it. A denied attempt on a client's files is precisely
    -- what an investigation needs, so the refusal comes back as data the way
    -- helm.reveal_secret() has done since 0210.
    v_uid := helm.audit(
      'document.download_denied', 'attachment', p_attachment_id, 'denied',
      CASE WHEN v_doc.id IS NOT NULL THEN v_doc.organization_id END, NULL,
      'not visible to this actor', '{}'::jsonb);
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text,
                        NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::bytea,
                        NULL::bytea, v_uid;
    RETURN;
  END IF;

  v_uid := helm.audit(
    'document.downloaded', 'attachment', v_doc.id, 'success',
    v_doc.organization_id, NULL, NULL,
    jsonb_build_object(
      'filename', v_doc.filename,
      'path', helm.document_folder_path(v_doc.folder_id),
      'byte_size', v_doc.byte_size,
      'is_internal_only', v_doc.is_internal_only,
      'archived', v_doc.archived_at IS NOT NULL));

  RETURN QUERY SELECT
    true, NULL::text,
    v_doc.id, v_doc.organization_id, v_doc.filename, v_doc.content_type,
    v_doc.byte_size, v_doc.storage_key, v_doc.data_key_id, v_doc.encryption_nonce,
    v_doc.content_sha256, v_uid;
END;
$$;

-- =============================================================================
-- Permanent deletion, archive first.
--
-- The same rail 0500 put in front of deleting a client or a credential, for the
-- same reason: permanent removal is never one click from a live record. Both
-- halves are enforced here rather than in a route, because a rule that lives in
-- the interface is one a script or a psql session walks past.
--
--   archiving a document   asset:write   tier1..3, super_admin AND client_admin
--   deleting one           asset:delete  tier2, tier3, super_admin — no
--                                        client-side role holds it
--
-- Confirmed against the catalogue rather than assumed; see db/tests/security.sql.
-- Nothing new was minted.
--
-- The bytes are NOT removed here. The row goes in this transaction and the
-- storage key comes back so the caller can unlink the file after it commits —
-- unlinking first would destroy a file that a rollback then un-deletes.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.delete_document(p_attachment_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_doc attachment%ROWTYPE;
BEGIN
  SELECT * INTO v_doc FROM attachment
  WHERE id = p_attachment_id
    AND tenant_id = helm.require_tenant_id()
    AND is_document
    AND deleted_at IS NULL;

  -- Every refusal below RETURNS rather than RAISES, for the reason spelled out
  -- in helm.open_document(): an audit row written and then raised past is an
  -- audit row that never existed. The caller reads `deleted` and reports the
  -- reason; db/tests/security.sql asserts both the refusal and its trail.
  IF NOT FOUND
     OR NOT helm.org_in_scope(v_doc.organization_id)
     OR NOT helm.internal_visible(v_doc.is_internal_only) THEN
    RETURN jsonb_build_object(
      'deleted', false, 'reason', 'not_found',
      'audit_event_uid', helm.audit(
        'document.delete_denied', 'attachment', p_attachment_id, 'denied',
        CASE WHEN v_doc.id IS NOT NULL THEN v_doc.organization_id END, NULL,
        'not visible to this actor', '{}'::jsonb));
  END IF;

  IF NOT helm.has_permission('asset:delete') THEN
    RETURN jsonb_build_object(
      'deleted', false, 'reason', 'forbidden',
      'message', 'asset:delete is required to delete a document',
      'audit_event_uid', helm.audit(
        'document.delete_denied', 'attachment', v_doc.id, 'denied',
        v_doc.organization_id, NULL, 'asset:delete not held',
        jsonb_build_object('filename', v_doc.filename)));
  END IF;

  IF v_doc.archived_at IS NULL THEN
    RETURN jsonb_build_object(
      'deleted', false, 'reason', 'not_archived',
      'message', format('%s must be archived before it can be deleted', v_doc.filename),
      'audit_event_uid', helm.audit(
        'document.delete_denied', 'attachment', v_doc.id, 'denied',
        v_doc.organization_id, NULL, 'not archived',
        jsonb_build_object('filename', v_doc.filename)));
  END IF;

  -- Before the row goes, so the trail carries what was destroyed. audit_log has
  -- no foreign key into attachment — checked in the guards below — so this
  -- survives the deletion.
  PERFORM helm.audit(
    'document.deleted', 'attachment', v_doc.id, 'success',
    v_doc.organization_id, NULL, NULL,
    jsonb_build_object(
      'filename', v_doc.filename,
      'path', helm.document_folder_path(v_doc.folder_id),
      'byte_size', v_doc.byte_size,
      'content_sha256', encode(v_doc.content_sha256, 'hex'),
      'is_internal_only', v_doc.is_internal_only));

  DELETE FROM attachment WHERE id = v_doc.id;

  RETURN jsonb_build_object('deleted', true, 'storage_key', v_doc.storage_key);
END;
$$;

-- =============================================================================
-- Deleting a folder: it must be empty.
--
-- WHY EMPTY-FIRST RATHER THAN A CASCADE WITH A CONFIRMATION. The two
-- destructive operations this product already has — delete a client, delete a
-- credential — are both gated on archive-first rather than on a dialog, because
-- a dialog is a thing people click. A cascade would also have to decide what
-- happens to the archived documents inside, and "archived, then destroyed by a
-- folder delete somebody did not realise reached them" is exactly the outcome
-- archiving exists to prevent.
--
-- The ON DELETE RESTRICT on both foreign keys is what actually enforces it. This
-- trigger exists to say so in words, and to record the deletion: a raw 23503
-- naming a constraint is not an answer a technician can act on.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.document_folder_before_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_folders integer;
  v_files   integer;
BEGIN
  SELECT count(*) INTO v_folders FROM document_folder WHERE parent_id = OLD.id;
  SELECT count(*) INTO v_files FROM attachment
  WHERE folder_id = OLD.id AND deleted_at IS NULL;

  IF v_folders > 0 OR v_files > 0 THEN
    RAISE EXCEPTION
      'helm: % is not empty (% subfolder(s), % document(s)); move or delete its contents first',
      OLD.name, v_folders, v_files
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  PERFORM helm.audit(
    'document_folder.deleted', 'document_folder', OLD.id, 'success',
    OLD.organization_id, NULL, NULL,
    jsonb_build_object('name', OLD.name, 'path', helm.document_folder_path(OLD.id)));

  RETURN OLD;
END;
$$;

CREATE TRIGGER document_folder_before_delete
  BEFORE DELETE ON document_folder
  FOR EACH ROW EXECUTE FUNCTION helm.document_folder_before_delete();

-- =============================================================================
-- Grants. 0220's default privileges already gave helm_app DML on document_folder
-- and helm_auditor SELECT; functions in schema helm are revoked from PUBLIC by
-- the same file, so each one is named here.
-- =============================================================================
REVOKE ALL ON FUNCTION helm.open_document(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.delete_document(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.document_folder_path(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION helm.project_attachment(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION helm.open_document(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.delete_document(uuid) TO helm_app;
GRANT EXECUTE ON FUNCTION helm.document_folder_path(uuid) TO helm_app, helm_auditor;
-- The projector runs inside triggers on attachment and document_folder, so
-- every role that may write either needs it.
GRANT EXECUTE ON FUNCTION helm.project_attachment(uuid) TO helm_app;

-- =============================================================================
-- Guards.
--
-- Catalogue facts only: this file runs before 0900 seeds the role catalogue, so
-- "asset:delete is held by nobody client-side" is asserted in
-- db/tests/security.sql where the seeds exist, not here.
-- =============================================================================
DO $document_guard$
DECLARE
  v_missing text;
  v_count   integer;
BEGIN
  -- 1. THE NEW TABLE IS PROTECTED LIKE EVERY OTHER FLAGGED ONE. Counted rather
  --    than assumed: apply_tenant_rls takes the internal-only column as an
  --    argument, so omitting it is a silent widening rather than an error.
  SELECT count(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'document_folder'
    AND c.relrowsecurity AND c.relforcerowsecurity;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'helm: document_folder did not end up with RLS enabled and forced';
  END IF;

  SELECT string_agg(p.polname, ', ' ORDER BY p.polname) INTO v_missing
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname = 'document_folder'
    AND pg_get_expr(coalesce(p.polqual, p.polwithcheck), p.polrelid) NOT LIKE '%internal_visible%';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: these document_folder policies do not consult the internal-only flag: %',
      v_missing;
  END IF;

  SELECT count(*) INTO v_count FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname = 'document_folder';
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'helm: document_folder has % policies, expected 4', v_count;
  END IF;

  -- 2. NEITHER FOREIGN KEY INTO THE TREE CASCADES. This is the whole of
  --    "a folder must be emptied first" and "a document keeps its folder"; the
  --    trigger above only explains it.
  SELECT string_agg(conname, ', ' ORDER BY conname) INTO v_missing
  FROM pg_constraint
  WHERE conname IN ('document_folder_parent_fk', 'attachment_folder_fk')
    AND confdeltype <> 'r';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: these foreign keys are no longer ON DELETE RESTRICT: %', v_missing;
  END IF;

  SELECT count(*) INTO v_count FROM pg_constraint
  WHERE conname IN ('document_folder_parent_fk', 'attachment_folder_fk');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'helm: expected both document folder foreign keys, found %', v_count;
  END IF;

  -- 3. THE NAMESPACE IS REAL AT THE TOP LEVEL. Without NULLS NOT DISTINCT a
  --    unique index over a nullable parent_id or folder_id constrains nothing
  --    there, because every NULL differs from every other — so two top-level
  --    folders, or two root documents, could share a name and the tree would
  --    show duplicates nobody could tell apart.
  FOR v_missing IN
    SELECT unnest(ARRAY['document_folder_sibling_name_uk', 'attachment_document_name_uk'])
  LOOP
    SELECT count(*) INTO v_count FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = v_missing AND i.indisunique AND i.indnullsnotdistinct;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'helm: % is not a UNIQUE ... NULLS NOT DISTINCT index', v_missing;
    END IF;
  END LOOP;

  -- 4. THE COLUMNS AND THEIR CHECKS. A document is never also an asset
  --    attachment, and folder_id never means anything on one that is.
  SELECT string_agg(c.conname, ', ' ORDER BY c.conname) INTO v_missing
  FROM unnest(ARRAY['attachment_folder_is_document', 'attachment_document_not_node']) AS w(name)
  LEFT JOIN pg_constraint c ON c.conname = w.name AND c.contype = 'c'
  WHERE c.conname IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'helm: missing attachment document constraints';
  END IF;

  -- 5. DELETION STAYS ARCHIVE-FIRST AND STAYS ABOVE ARCHIVING. Read out of the
  --    function's own text, so removing either check fails this migration's
  --    next fresh build rather than passing review.
  IF pg_get_functiondef('helm.delete_document(uuid)'::regprocedure) NOT LIKE '%archived_at IS NULL%' THEN
    RAISE EXCEPTION 'helm: delete_document no longer requires the document to be archived first';
  END IF;
  IF pg_get_functiondef('helm.delete_document(uuid)'::regprocedure) NOT LIKE '%asset:delete%' THEN
    RAISE EXCEPTION 'helm: delete_document no longer checks asset:delete';
  END IF;
  IF pg_get_functiondef('helm.open_document(uuid)'::regprocedure) NOT LIKE '%internal_visible%' THEN
    RAISE EXCEPTION 'helm: open_document no longer applies the internal-only rule it bypasses RLS for';
  END IF;
  IF pg_get_functiondef('helm.open_document(uuid)'::regprocedure) NOT LIKE '%document.downloaded%' THEN
    RAISE EXCEPTION 'helm: open_document no longer writes an audit event';
  END IF;

  -- 5b. A REFUSAL IS RETURNED, NOT RAISED, so its audit row survives. Both
  --     functions write a denial and then hand it back; a RAISE anywhere
  --     between the two rolls the row away and the refusal leaves no trace.
  --     This is the failure mode helm.reveal_secret() was shaped to avoid.
  FOR v_missing IN SELECT unnest(ARRAY['helm.open_document(uuid)', 'helm.delete_document(uuid)'])
  LOOP
    IF pg_get_functiondef(v_missing::regprocedure) NOT LIKE '%_denied%' THEN
      RAISE EXCEPTION 'helm: % no longer records a refusal', v_missing;
    END IF;
    IF pg_get_functiondef(v_missing::regprocedure) ~ 'denied.*\n[^$]*RAISE EXCEPTION' THEN
      RAISE EXCEPTION 'helm: % raises after auditing a denial, which discards the row', v_missing;
    END IF;
  END LOOP;

  -- 6. THE TRAIL OUTLIVES THE FILE. Same property 0500 depends on: audit_log
  --    carries entity ids as plain uuids, so deleting a document cannot take
  --    the record of its deletion with it.
  SELECT count(*) INTO v_count
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  WHERE con.contype = 'f'
    AND con.confrelid = 'public.attachment'::regclass
    AND child.relname LIKE 'audit_log%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'helm: audit_log now has a foreign key into attachment; '
                    'deleting a document would take its own audit trail with it';
  END IF;

  RAISE NOTICE '0560: document_folder created; attachment carries documents';
END
$document_guard$;
