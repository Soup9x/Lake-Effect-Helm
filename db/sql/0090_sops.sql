-- =============================================================================
-- 0090_sops.sql — procedures and interactive checklist execution
--
-- A checklist run is evidence. Six months after an offboarding goes wrong, the
-- question is "which steps did we actually complete, and what did the procedure
-- say at the time" — so a run snapshots the SOP version it executed against.
-- Pointing a run at a living, editable document would let today's edit rewrite
-- yesterday's evidence.
-- =============================================================================

SET search_path = public, extensions;

CREATE TYPE sop_step_kind AS ENUM ('manual', 'verification', 'command', 'link', 'approval', 'decision');

CREATE TYPE sop_run_status AS ENUM ('not_started', 'in_progress', 'blocked', 'completed', 'abandoned');

CREATE TYPE sop_step_status AS ENUM ('pending', 'in_progress', 'done', 'skipped', 'blocked', 'failed', 'not_applicable');

-- -----------------------------------------------------------------------------
-- sop — the procedure. A graph node, so "which SOPs cover this firewall" is a
-- graph query rather than a tagging convention.
-- -----------------------------------------------------------------------------
CREATE TABLE sop (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  node_type            node_type NOT NULL DEFAULT 'sop',

  category             text,
  summary              text,
  body                 text,                     -- Markdown
  current_version      integer NOT NULL DEFAULT 0,

  -- Procedures rot. An SOP past its review date is flagged in the same
  -- expirations pane as an expiring certificate.
  review_interval_days integer,
  last_reviewed_at     timestamptz,
  reviewed_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  owner_user_id        uuid REFERENCES app_user(id) ON DELETE SET NULL,

  -- Global SOPs live on the MSP's internal organisation and apply everywhere;
  -- this flag is what makes them visible from every client context.
  is_global            boolean NOT NULL DEFAULT false,
  requires_approval    boolean NOT NULL DEFAULT false,
  estimated_minutes    integer,

  CONSTRAINT sop_node_tenant_fk FOREIGN KEY (id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sop_node_type_fk FOREIGN KEY (id, node_type)
    REFERENCES asset_node (id, node_type) ON DELETE CASCADE,
  CONSTRAINT sop_node_type_pin CHECK (node_type = 'sop'),
  CONSTRAINT sop_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT sop_review_interval_sane CHECK (
    review_interval_days IS NULL OR review_interval_days BETWEEN 1 AND 3650
  ),
  CONSTRAINT sop_version_non_negative CHECK (current_version >= 0)
);
CREATE INDEX sop_category_idx ON sop (tenant_id, category);
CREATE INDEX sop_global_idx ON sop (tenant_id) WHERE is_global;
CREATE INDEX sop_review_due_idx ON sop (tenant_id, last_reviewed_at)
  WHERE review_interval_days IS NOT NULL;

-- -----------------------------------------------------------------------------
-- sop_step — the editable, current definition of each step.
-- -----------------------------------------------------------------------------
CREATE TABLE sop_step (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  sop_id            uuid NOT NULL,

  position          integer NOT NULL,
  title             text NOT NULL,
  body              text,
  kind              sop_step_kind NOT NULL DEFAULT 'manual',

  is_optional       boolean NOT NULL DEFAULT false,
  requires_evidence boolean NOT NULL DEFAULT false,
  requires_note     boolean NOT NULL DEFAULT false,
  -- A step that reveals a credential names it here, so the run links the
  -- procedure to the audit trail of the reveal.
  credential_node_id uuid,
  estimated_minutes integer,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sop_step_sop_fk FOREIGN KEY (sop_id, tenant_id)
    REFERENCES sop (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sop_step_credential_fk FOREIGN KEY (credential_node_id, tenant_id)
    REFERENCES credential (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT sop_step_position_uk UNIQUE (sop_id, position),
  CONSTRAINT sop_step_position_positive CHECK (position > 0)
);
CREATE INDEX sop_step_sop_idx ON sop_step (sop_id, position);

-- -----------------------------------------------------------------------------
-- sop_version — a frozen snapshot: the body plus every step, as JSON.
-- -----------------------------------------------------------------------------
CREATE TABLE sop_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  sop_id       uuid NOT NULL,
  version      integer NOT NULL,

  snapshot     jsonb NOT NULL,
  -- sha256 over the canonical snapshot. Lets an export assert "this run
  -- followed exactly this text" without shipping the whole document twice.
  snapshot_sha256 bytea NOT NULL,
  change_note  text,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT sop_version_uk UNIQUE (sop_id, version),
  CONSTRAINT sop_version_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT sop_version_sop_fk FOREIGN KEY (sop_id, tenant_id)
    REFERENCES sop (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sop_version_positive CHECK (version > 0),
  CONSTRAINT sop_version_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT sop_version_sha_len CHECK (octet_length(snapshot_sha256) = 32)
);

CREATE TRIGGER sop_version_append_only
  BEFORE UPDATE OR DELETE ON sop_version
  FOR EACH ROW EXECUTE FUNCTION helm.deny_mutation();

-- -----------------------------------------------------------------------------
-- sop_run — one execution of a procedure.
-- -----------------------------------------------------------------------------
CREATE TABLE sop_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  organization_id  uuid NOT NULL,
  site_id          uuid,

  sop_id           uuid NOT NULL,
  sop_version_id   uuid NOT NULL,
  status           sop_run_status NOT NULL DEFAULT 'not_started',

  title            text NOT NULL,
  ticket_ref       text,
  -- The asset this run is about, when there is one (the server being rebuilt,
  -- the user being offboarded).
  subject_node_id  uuid,

  started_at       timestamptz,
  started_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  completed_at     timestamptz,
  completed_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  abandoned_reason text,
  approved_at      timestamptz,
  approved_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sop_run_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT sop_run_org_fk FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sop_run_site_fk FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT sop_run_sop_fk FOREIGN KEY (sop_id, tenant_id)
    REFERENCES sop (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sop_run_version_fk FOREIGN KEY (sop_version_id, tenant_id)
    REFERENCES sop_version (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sop_run_subject_fk FOREIGN KEY (subject_node_id, tenant_id)
    REFERENCES asset_node (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT sop_run_completion_consistent CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT sop_run_abandoned_has_reason CHECK (
    status <> 'abandoned' OR abandoned_reason IS NOT NULL
  )
);
CREATE INDEX sop_run_org_idx ON sop_run (tenant_id, organization_id, status);
CREATE INDEX sop_run_sop_idx ON sop_run (sop_id, created_at DESC);
CREATE INDEX sop_run_open_idx ON sop_run (tenant_id, status)
  WHERE status IN ('not_started', 'in_progress', 'blocked');

-- -----------------------------------------------------------------------------
-- sop_run_step — per-step execution state.
--
-- Step definition is COPIED in, not referenced: sop_step rows can be edited or
-- deleted, and a completed run must still be readable years later.
-- -----------------------------------------------------------------------------
CREATE TABLE sop_run_step (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  run_id         uuid NOT NULL,

  position       integer NOT NULL,
  title          text NOT NULL,
  body           text,
  kind           sop_step_kind NOT NULL,
  is_optional    boolean NOT NULL DEFAULT false,
  requires_evidence boolean NOT NULL DEFAULT false,

  status         sop_step_status NOT NULL DEFAULT 'pending',
  note           text,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at     timestamptz,
  completed_at   timestamptz,
  completed_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  -- Populated when the step revealed a credential, linking procedure to audit.
  audit_event_uid uuid,

  CONSTRAINT sop_run_step_run_fk FOREIGN KEY (run_id, tenant_id)
    REFERENCES sop_run (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sop_run_step_position_uk UNIQUE (run_id, position),
  CONSTRAINT sop_run_step_evidence_object CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT sop_run_step_terminal_has_actor CHECK (
    status NOT IN ('done', 'skipped', 'failed', 'not_applicable')
    OR completed_at IS NOT NULL
  ),
  -- A step that demands evidence cannot be closed as done without any.
  CONSTRAINT sop_run_step_evidence_present CHECK (
    NOT requires_evidence OR status <> 'done' OR evidence <> '{}'::jsonb
  ),
  -- Skipping a mandatory step requires an explanation.
  CONSTRAINT sop_run_step_skip_needs_note CHECK (
    status <> 'skipped' OR is_optional OR note IS NOT NULL
  )
);
CREATE INDEX sop_run_step_run_idx ON sop_run_step (run_id, position);

CREATE TRIGGER sop_run_touch BEFORE UPDATE ON sop_run
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();
CREATE TRIGGER sop_step_touch BEFORE UPDATE ON sop_step
  FOR EACH ROW EXECUTE FUNCTION helm.touch_updated_at();

-- Progress projection for the run list.
CREATE VIEW v_sop_run_progress
  WITH (security_invoker = true, security_barrier = true) AS
SELECT
  r.id AS run_id,
  r.tenant_id,
  r.organization_id,
  r.sop_id,
  r.title,
  r.status,
  r.ticket_ref,
  r.started_at,
  r.completed_at,
  count(s.*)                                              AS total_steps,
  count(*) FILTER (WHERE s.status = 'done')               AS done_steps,
  count(*) FILTER (WHERE s.status IN ('blocked', 'failed')) AS problem_steps,
  count(*) FILTER (WHERE s.status = 'pending' AND NOT s.is_optional) AS remaining_required_steps,
  CASE WHEN count(s.*) = 0 THEN 0
       ELSE round(100.0 * count(*) FILTER (WHERE s.status <> 'pending') / count(s.*))
  END AS percent_touched
FROM sop_run r
LEFT JOIN sop_run_step s ON s.run_id = r.id
GROUP BY r.id, r.tenant_id, r.organization_id, r.sop_id, r.title, r.status,
         r.ticket_ref, r.started_at, r.completed_at;
