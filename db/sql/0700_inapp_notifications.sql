-- =============================================================================
-- 0700 — the in-app notification store
--
-- WHAT 0110 AND 0420 AND 0690 ALL LEFT OUT. §1 of
-- docs/architecture/10-notifications.md is about 0110 shipping
-- webhook_endpoint and webhook_delivery with nothing wired to them. 0420 wired
-- them. 0690 gave them a second transport. All three queues point OUTWARDS: a
-- webhook_delivery row belongs to a destination, a task_reminder row is a
-- message about to be sent. Not one of them is a per-person inbox, which is why
-- the header's bell could not be built until now — and why it was going to ship
-- as a stub if this group had not built the store.
--
-- A BELL THAT CANNOT BE DISTINGUISHED FROM AN EMPTY INBOX IS WORSE THAN NO
-- BELL, which is the sentence the parity plan has carried for group L since it
-- was written. That is what `read_at` is for: an unread count is a claim about
-- what this person has not seen, and it cannot be derived from an outbound
-- queue at all.
--
-- TWO SOURCES, MIRRORING THE OUTBOUND QUEUE'S TWO:
--
--   THE AUDIT FAN-OUT, for things an MSP watches — an export, a reveal, a
--   refusal, an expiry, a failing sync. Addressed to every tenant-wide seat
--   holding audit:read, which is decision 31's rule written set-based.
--
--   THE REMINDER QUEUE, for work assigned to one person. A trigger on
--   task_reminder, so both writers (the hourly sweep and the route's
--   raise_assignment_reminder) are covered by one place rather than two.
--
-- AND IT IS NOT JOINED TO webhook_endpoint, deliberately. The fan-out's
-- existing INSERT joins candidate rows to subscribed endpoints, so an event
-- nobody subscribed to produces nothing. The in-app insert is driven by the
-- candidate rows directly: a tenant with no webhook destination and no mail
-- relay still has a working bell, which is the air-gapped install every other
-- part of this system is built for.
--
-- PREFERENCE KINDS GROW, AND THE DEFAULT SPLITS. 0690 shipped two kinds, both
-- on when no row exists. This adds four oversight kinds and they default OFF:
-- "you were given work and a deadline" is something to tell somebody without
-- being asked, and "every export in the tenant" is a feed to opt into. The
-- distinction is in helm.default_notification_kinds(), one place, so the SQL
-- default, the validator and the TypeScript mirror cannot disagree about it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The kind catalogue, and the two halves of it.
--
-- Reissued rather than edited: 0690's version is an applied migration and
-- immutable. One function holds the legal set, one holds the default, and the
-- TypeScript mirror in src/lib/notifications/kinds.ts is checked against both
-- by tests/integration/email-settings.test.ts — the construction 0370 used for
-- user_dashboard.widgets and 0620 for user_sidebar.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_kinds() RETURNS text[]
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT ARRAY[
    -- Mine. 0690's two, and they stay the default.
    'task_assigned',
    'task_due',
    -- Oversight. Off until somebody asks for them, because each is a feed of
    -- everything that happens in the tenant rather than a message about this
    -- person's own work.
    'export_activity',
    'credential_access',
    'expiring_soon',
    'operations'
  ]::text[];
$$;

COMMENT ON FUNCTION helm.notification_kinds() IS
  'Every legal notification kind. Mirrored by NOTIFICATION_KINDS in '
  'src/lib/notifications/kinds.ts, with a test asserting the two agree.';

CREATE OR REPLACE FUNCTION helm.default_notification_kinds() RETURNS text[]
  LANGUAGE sql IMMUTABLE
AS $$
  -- WHAT SOMEBODY GETS BEFORE THEY HAVE TOUCHED THE SETTING, and the split is
  -- the decision rather than an accident of which kinds came first. Being told
  -- that work was assigned to you is not a subscription; being told about every
  -- export in the business is. Defaulting the oversight kinds on would also
  -- have meant emailing every administrator about every export the moment 0700
  -- applied, which nobody asked for.
  SELECT ARRAY['task_assigned', 'task_due']::text[];
$$;

COMMENT ON FUNCTION helm.default_notification_kinds() IS
  'The kinds in force when no user_notification_preference row exists. An '
  'EMPTY stored array is not this: it means somebody turned everything off.';

CREATE OR REPLACE FUNCTION helm.notification_kinds_valid(p_kinds jsonb)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT jsonb_typeof(p_kinds) = 'array'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_kinds) k
       WHERE k <> ALL (helm.notification_kinds())
     )
     -- A duplicate would make "is this enabled" depend on which copy is read.
     AND (SELECT count(DISTINCT k) FROM jsonb_array_elements_text(p_kinds) k)
       = jsonb_array_length(p_kinds);
$$;

-- -----------------------------------------------------------------------------
-- Which kind governs an audit event.
--
-- NULL means "nothing in-app for this", which is most of the audit log: the
-- fan-out examines hundreds of rows an hour and the overwhelming majority map
-- to no event at all, let alone a kind somebody wants in a bell.
--
-- Grouped rather than one kind per event, because six checkboxes a person can
-- reason about beats nine they will tick all of or none of. The grouping is
-- also the honest one: a reveal and a refusal are the same question asked two
-- ways ("who is touching credentials"), and a rotated key and a failing sync
-- are both "the machinery needs looking at".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_kind_for_event(p_event text)
  RETURNS text
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_event
    WHEN 'export.requested'    THEN 'export_activity'
    WHEN 'export.rendered'     THEN 'export_activity'
    WHEN 'export.downloaded'   THEN 'export_activity'
    WHEN 'export.revoked'      THEN 'export_activity'
    WHEN 'secret.revealed'     THEN 'credential_access'
    WHEN 'access.denied'       THEN 'credential_access'
    WHEN 'expiration.warning'  THEN 'expiring_soon'
    WHEN 'integration.failed'  THEN 'operations'
    WHEN 'key.rotated'         THEN 'operations'
  END;
$$;

COMMENT ON FUNCTION helm.notification_kind_for_event(text) IS
  'The preference kind governing an outbound notification event, or NULL when '
  'the event has no in-app counterpart. One place, so the fan-out and the '
  'settings screen cannot disagree about what a checkbox covers.';

-- -----------------------------------------------------------------------------
-- Whether one person wants one kind.
--
-- THE ABSENT ROW IS THE INTERESTING CASE, exactly as 0690 has it: no row means
-- the shipped default, an empty array means somebody turned everything off, and
-- collapsing the two would make the controls appear to do nothing. Written once
-- here so the fan-out, the reminder trigger and the email sender all ask the
-- same question.
--
-- STABLE and not SECURITY DEFINER: it is called from definer functions that
-- already hold the rights, and making it a definer function of its own would
-- let any caller ask about anybody.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_kind_enabled(
  p_tenant_id uuid,
  p_user_id   uuid,
  p_kind      text
) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    (SELECT p.kinds ? p_kind
       FROM user_notification_preference p
      WHERE p.tenant_id = p_tenant_id AND p.user_id = p_user_id),
    p_kind = ANY (helm.default_notification_kinds())
  );
$$;

-- -----------------------------------------------------------------------------
-- The inbox.
--
-- ONE ROW PER PERSON PER THING, which is what makes it an inbox rather than a
-- log. `dedupe_key` is one column carrying two shapes — an audit event_uid, or
-- 'step:<uuid>:<lead>' for a reminder — rather than two nullable columns and a
-- partial unique index per shape. The key is what makes a second fan-out pass,
-- a rewound cursor or two overlapping workers produce the same row instead of a
-- second bell.
--
-- `href` IS STORED, NOT DERIVED. A notification is read weeks later, by which
-- time the row it names may be archived or deleted; a stored path still
-- navigates somewhere that can say so, where a path rebuilt from a missing row
-- cannot be built at all. It is also the only thing a bell needs from the
-- subject matter, so nothing else has to be joined to render the list.
-- -----------------------------------------------------------------------------
CREATE TABLE user_notification (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,

  kind            text NOT NULL,
  -- Idempotency. See the note above on why this is one column.
  dedupe_key      text NOT NULL,

  subject         text NOT NULL,
  -- Where this goes when clicked. NULL for something with nowhere to go.
  href            text,
  -- Which client it is about, when it is about one. Carried so the bell can say
  -- "ACME" without joining, and so a purge takes the notification with it.
  organization_id uuid,

  -- When the THING happened, which is not when the row was written: the fan-out
  -- runs on a cursor and can be minutes behind. A bell ordered by created_at
  -- would put a backlog in the wrong order after an outage.
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,

  CONSTRAINT user_notification_tenant_uk UNIQUE (id, tenant_id),
  CONSTRAINT user_notification_dedupe_uk
    UNIQUE (tenant_id, user_id, kind, dedupe_key),
  CONSTRAINT user_notification_member_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT user_notification_org_fk
    FOREIGN KEY (organization_id, tenant_id)
    REFERENCES organization (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT user_notification_kind_known
    CHECK (kind = ANY (helm.notification_kinds())),
  CONSTRAINT user_notification_subject_present
    CHECK (length(btrim(subject)) BETWEEN 1 AND 400),
  -- A relative path only. An absolute URL in a bell is somewhere else's site,
  -- and the subject lines here name clients and credential labels.
  CONSTRAINT user_notification_href_relative
    CHECK (href IS NULL OR href ~ '^/[^[:space:]]*$')
);

-- The bell's own query: this person's rows, newest first. `read_at` is in the
-- index so the unread count is answered from it without touching the heap.
CREATE INDEX user_notification_mine_idx
  ON user_notification (tenant_id, user_id, occurred_at DESC)
  INCLUDE (read_at);

-- The unread count, which is the thing rendered on every page load.
CREATE INDEX user_notification_unread_idx
  ON user_notification (tenant_id, user_id)
  WHERE read_at IS NULL;

-- The retention sweep below, which scans by age across every user.
CREATE INDEX user_notification_age_idx ON user_notification (tenant_id, created_at);

COMMENT ON TABLE user_notification IS
  'The per-person in-app inbox. 0110, 0420 and 0690 built three OUTBOUND '
  'queues; none of them can express "this person has not seen this", which is '
  'what a bell is. Written only by definer functions and a trigger; the owner '
  'may read it and may set read_at, by a column grant.';

COMMENT ON COLUMN user_notification.dedupe_key IS
  'An audit event_uid, or ''step:<uuid>:<lead>'' for a reminder. One column '
  'rather than two nullable ones, so the uniqueness is one constraint.';

-- -----------------------------------------------------------------------------
-- Addressing an oversight notification.
--
-- DECISION 31'S RULE, WRITTEN SET-BASED. helm.is_tenant_wide() reads the
-- session and so cannot be asked about somebody else; this is the same test
-- against the membership row: a tenant-wide seat (org_scope_all) whose role
-- holds audit:read. client_admin holds audit:read and is NOT tenant-wide, which
-- is exactly the leak 0690 had to correct — so the function exists to stop the
-- same mistake being made a third time in a different shape.
--
-- An expired or suspended membership addresses nobody: 0690's reminder sweep
-- learned that `membership` has `status` and `expires_at` rather than an
-- is_active flag, and this follows it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notification_audience(
  p_tenant_id uuid,
  p_kind      text
) RETURNS TABLE (user_id uuid)
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT mb.user_id
  FROM membership mb
  WHERE mb.tenant_id = p_tenant_id
    AND mb.status = 'active'
    AND (mb.expires_at IS NULL OR mb.expires_at > now())
    AND mb.org_scope_all
    AND EXISTS (
      SELECT 1 FROM role_permission rp
      WHERE rp.role_key = mb.role_key AND rp.permission_key = 'audit:read'
    )
    -- A person is in the audience only if they asked to be. The oversight kinds
    -- default off, so this is empty until somebody opts in — which is the
    -- intended quiet start rather than a broken feature.
    AND helm.notification_kind_enabled(p_tenant_id, mb.user_id, p_kind);
$$;

COMMENT ON FUNCTION helm.notification_audience(uuid, text) IS
  'Who receives an oversight notification: a tenant-wide seat holding '
  'audit:read that has opted into the kind. The set-based form of decision '
  '31 — a permission is not a scope, so org_scope_all is tested too.';

-- -----------------------------------------------------------------------------
-- Whether anybody in this tenant could want an in-app row.
--
-- THE FAN-OUT JOB ONLY VISITS TENANTS THAT HAVE AN ACTIVE WEBHOOK ENDPOINT.
-- 0420 put that pre-filter in the worker's enumeration to avoid a transaction
-- per tenant per minute for nothing, which was right while the only output was
-- a webhook. It is wrong the moment the fan-out also fills a bell: the INSERT
-- below deliberately does not join to webhook_endpoint, and all of that care is
-- undone one level up if the job never calls the function at all.
--
-- So the pre-filter needs the other half, and the rule lives HERE rather than
-- in the worker's SQL string, because it has to stay in step with
-- helm.notification_audience(): the oversight kinds are off by default, so a
-- tenant where nobody has opted into one has no in-app audience and genuinely
-- has nothing to do. A stored preference row naming a non-default kind is
-- exactly that condition, cheaply.
--
-- Found by reading the worker after writing the migration, not by a guard — a
-- guard can assert what this file says and cannot see a predicate in
-- TypeScript. tests/integration/inapp-notifications.test.ts is what holds it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.has_inapp_audience(p_tenant_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_notification_preference p
    WHERE p.tenant_id = p_tenant_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(p.kinds) k
        WHERE k.value <> ALL (helm.default_notification_kinds())
      )
  );
$$;

COMMENT ON FUNCTION helm.has_inapp_audience(uuid) IS
  'Whether anybody in this tenant has opted into an oversight notification '
  'kind. The fan-out job''s pre-filter, which was endpoint-only until 0700 and '
  'would otherwise have skipped every tenant that wanted a bell and no webhook.';

GRANT EXECUTE ON FUNCTION helm.has_inapp_audience(uuid) TO helm_worker;

-- =============================================================================
-- The fan-out, taught to fill the inbox
--
-- Reissued whole because an applied migration is immutable. Everything from
-- 0420 is unchanged — the cursor, the candidate window, the webhook insert, the
-- counting — and one CTE is added. Three things about the addition matter:
--
--   IT IS DRIVEN BY `candidate`, NOT BY THE WEBHOOK INSERT, so a tenant with no
--   destination at all still gets a bell. Joining it to webhook_endpoint would
--   have made the in-app surface a side effect of configuring Discord.
--
--   IT REUSES helm.notification_subject() AND helm.notification_payload(), so
--   the bell says the same words the channels do, filtered by the same
--   allow-list. §2's rule is that formatting differs between platforms and
--   facts do not, and a bell is another platform.
--
--   THE COUNT RETURNED IS STILL THE WEBHOOK COUNT. `queued` means "deliveries
--   queued" in 0420's tests and in the worker's log line, and quietly changing
--   what a number means is worse than adding one — so in-app rows are counted
--   separately, in a new OUT column.
-- =============================================================================
DROP FUNCTION IF EXISTS helm.fan_out_notifications(integer);

CREATE OR REPLACE FUNCTION helm.fan_out_notifications(p_limit integer DEFAULT 500)
  RETURNS TABLE (examined integer, queued integer, cursor_at bigint, notified integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant   uuid := helm.require_tenant_id();
  v_from     bigint;
  v_high     bigint;
  v_examined integer := 0;
  v_queued   integer := 0;
  v_notified integer := 0;
BEGIN
  INSERT INTO notification_cursor (tenant_id, last_chain_seq)
  VALUES (v_tenant, 0)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT last_chain_seq INTO v_from
  FROM notification_cursor WHERE tenant_id = v_tenant
  FOR UPDATE;

  WITH candidate AS (
    SELECT a.event_uid, a.chain_seq, a.action, a.outcome, a.actor_label,
           a.organization_id, a.occurred_at, a.metadata,
           helm.notification_event_for(a.action, a.outcome) AS event
    FROM audit_log a
    WHERE a.tenant_id = v_tenant
      AND a.chain_seq > v_from
    ORDER BY a.chain_seq
    LIMIT greatest(p_limit, 1)
  ),
  counted AS (
    SELECT count(*)::integer AS n, max(chain_seq) AS high FROM candidate
  ),
  queued AS (
    INSERT INTO webhook_delivery (
      tenant_id, endpoint_id, event_type, event_uid,
      organization_id, subject, payload, occurred_at)
    SELECT
      v_tenant, e.id, c.event, c.event_uid,
      c.organization_id,
      helm.notification_subject(
        c.event, c.actor_label, o.name,
        helm.notification_payload(c.event, c.metadata)),
      helm.notification_payload(c.event, c.metadata),
      c.occurred_at
    FROM candidate c
    JOIN webhook_endpoint e
      ON e.tenant_id = v_tenant
     AND e.is_active
     AND c.event = ANY (e.events)
     -- An endpoint scoped to one client hears only about that client. A
     -- tenant-wide endpoint (organization_id IS NULL) hears everything.
     AND (e.organization_id IS NULL OR e.organization_id = c.organization_id)
    LEFT JOIN organization o
      ON o.id = c.organization_id AND o.tenant_id = v_tenant
    WHERE c.event IS NOT NULL
    ON CONFLICT (endpoint_id, event_uid) DO NOTHING
    RETURNING 1
  ),
  -- 0700. The inbox. Note what this does NOT join to.
  inbox AS (
    INSERT INTO user_notification (
      tenant_id, user_id, kind, dedupe_key, subject, href,
      organization_id, occurred_at)
    SELECT
      v_tenant, aud.user_id, k.kind, c.event_uid,
      helm.notification_subject(
        c.event, c.actor_label, o.name,
        helm.notification_payload(c.event, c.metadata)),
      -- The client it is about, when it is about one. An event with no
      -- organisation — a key rotation, a tenant-wide refusal — has nowhere
      -- better to go than the audit log, which is where somebody looking into
      -- it ends up anyway.
      CASE WHEN c.organization_id IS NOT NULL
        THEN '/organizations/' || c.organization_id::text
        ELSE '/audit'
      END,
      c.organization_id,
      c.occurred_at
    FROM candidate c
    CROSS JOIN LATERAL (
      SELECT helm.notification_kind_for_event(c.event) AS kind
    ) k
    CROSS JOIN LATERAL helm.notification_audience(v_tenant, k.kind) aud
    LEFT JOIN organization o
      ON o.id = c.organization_id AND o.tenant_id = v_tenant
    WHERE c.event IS NOT NULL AND k.kind IS NOT NULL
    ON CONFLICT (tenant_id, user_id, kind, dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT counted.n, counted.high,
         (SELECT count(*)::integer FROM queued),
         (SELECT count(*)::integer FROM inbox)
    INTO v_examined, v_high, v_queued, v_notified
  FROM counted;

  IF v_high IS NOT NULL THEN
    UPDATE notification_cursor
    SET last_chain_seq = v_high, updated_at = now()
    WHERE tenant_id = v_tenant;
  END IF;

  RETURN QUERY SELECT coalesce(v_examined, 0), coalesce(v_queued, 0),
                      coalesce(v_high, v_from), coalesce(v_notified, 0);
END;
$$;

REVOKE ALL ON FUNCTION helm.fan_out_notifications(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.fan_out_notifications(integer) TO helm_worker;

-- -----------------------------------------------------------------------------
-- A reminder lights the bell too.
--
-- A TRIGGER RATHER THAN TWO CALL SITES. task_reminder is written by the hourly
-- sweep (helm.raise_task_reminders) and by the route that starts a run
-- (helm.raise_assignment_reminder). Putting the insert in both means a third
-- writer added later silently has no bell, which is the class of bug this
-- project keeps finding; putting it on the table means the inbox follows the
-- queue by construction.
--
-- ONLY A `pending` ROW. 0690 raises the earliest crossed lead as pending and
-- the rest as `suppressed`, so a step entered the day before its deadline
-- produces one message rather than three. Lighting the bell for a suppressed
-- row would undo exactly that.
--
-- AND THE KIND HAS TO BE WANTED. Same preference as the email, by design: a
-- person who turned task_due off has said what they want to hear about, and
-- honouring it in one channel and not the other is the kind of half-measure
-- somebody would have to discover.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.notify_task_reminder() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_kind    text := CASE NEW.kind WHEN 'assigned' THEN 'task_assigned' ELSE 'task_due' END;
  v_subject text;
  v_run     uuid;
  v_org     uuid;
  v_title   text;
BEGIN
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;
  IF NOT helm.notification_kind_enabled(NEW.tenant_id, NEW.user_id, v_kind) THEN
    RETURN NEW;
  END IF;

  SELECT s.run_id, r.organization_id, s.title
    INTO v_run, v_org, v_title
  FROM sop_run_step s
  JOIN sop_run r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
  WHERE s.id = NEW.step_id AND s.tenant_id = NEW.tenant_id;

  IF v_run IS NULL THEN RETURN NEW; END IF;

  v_subject := CASE NEW.kind
    WHEN 'assigned' THEN 'You were assigned: ' || v_title
    -- The lead day says which of the three this is, in the words the email
    -- uses. Lead 0 covers due-now and overdue both, which is 0690's rule.
    WHEN 'due' THEN CASE
      WHEN NEW.lead_day = 0 THEN 'Due today: ' || v_title
      WHEN NEW.lead_day = 1 THEN 'Due tomorrow: ' || v_title
      ELSE 'Due in ' || NEW.lead_day || ' days: ' || v_title
    END
  END;

  INSERT INTO user_notification (
    tenant_id, user_id, kind, dedupe_key, subject, href,
    organization_id, occurred_at)
  VALUES (
    NEW.tenant_id, NEW.user_id, v_kind,
    -- The lead is IN the key, so three leads on one step are three rows the
    -- bell can show — and re-raising the same lead is still one.
    'step:' || NEW.step_id::text || ':' || NEW.lead_day::text,
    left(v_subject, 400),
    '/runs/' || v_run::text,
    v_org,
    now())
  ON CONFLICT (tenant_id, user_id, kind, dedupe_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER task_reminder_notify
  AFTER INSERT ON task_reminder
  FOR EACH ROW EXECUTE FUNCTION helm.notify_task_reminder();

COMMENT ON FUNCTION helm.notify_task_reminder() IS
  'Mirrors a pending task_reminder into the in-app inbox. A trigger so both '
  'of 0690''s writers are covered by one place, and so a third added later '
  'cannot forget.';

-- -----------------------------------------------------------------------------
-- Reading the bell.
--
-- TWO FUNCTIONS, because the two questions have very different costs. The count
-- is rendered on every page load and is answered from a partial index; the list
-- is fetched when somebody opens the popover, which is the same split
-- /api/workspace/recent chose in 0370 and for the same reason.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION helm.unread_notification_count() RETURNS integer
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT count(*)::integer
  FROM user_notification
  WHERE tenant_id = helm.current_tenant_id()
    AND user_id = helm.current_actor_id()
    AND read_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION helm.my_notifications(p_limit integer DEFAULT 20)
  RETURNS TABLE (
    id uuid, kind text, subject text, href text,
    organization_id uuid, organization_name text,
    occurred_at timestamptz, read_at timestamptz
  )
  LANGUAGE sql STABLE
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT n.id, n.kind, n.subject, n.href,
         n.organization_id, o.name,
         n.occurred_at, n.read_at
  FROM user_notification n
  LEFT JOIN organization o
    ON o.id = n.organization_id AND o.tenant_id = n.tenant_id
  WHERE n.tenant_id = helm.current_tenant_id()
    AND n.user_id = helm.current_actor_id()
  -- occurred_at, not created_at: the fan-out runs on a cursor and can be
  -- minutes behind, so a backlog after an outage would otherwise arrive in the
  -- order it was processed rather than the order it happened.
  ORDER BY n.occurred_at DESC, n.id
  LIMIT greatest(p_limit, 1);
$$;

COMMENT ON FUNCTION helm.my_notifications(integer) IS
  'This person''s bell. Not SECURITY DEFINER: RLS already admits only the '
  'owner''s rows, so the policy is the authorisation and a definer function '
  'would be a way to ask about somebody else.';

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE user_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification FORCE ROW LEVEL SECURITY;

-- AN INBOX IS PRIVATE, with no audit:read carve-out at all — not even for a
-- tenant-wide seat. Same rule as user_notification_preference and for the
-- stronger reason: what somebody has and has not read is a record of their
-- attention. The oversight content is in audit_log, where anybody with the
-- permission can read it without reading somebody's unread count.
CREATE POLICY user_notification_rls_select ON user_notification
  FOR SELECT USING (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  );
-- INSERT is policed as well as revoked. The revoke below is what stops
-- helm_app; this is what constrains the definer functions under FORCE.
CREATE POLICY user_notification_rls_insert ON user_notification
  FOR INSERT WITH CHECK (tenant_id = helm.current_tenant_id());
CREATE POLICY user_notification_rls_update ON user_notification
  FOR UPDATE USING (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  ) WITH CHECK (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  );
CREATE POLICY user_notification_rls_delete ON user_notification
  FOR DELETE USING (
    tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  );

-- =============================================================================
-- Grants
--
-- THE COLUMN GRANT IS THE LOAD-BEARING PART. Marking something read is the
-- owner's own write and belongs in the request path, so helm_app holds UPDATE
-- — but on `read_at` ALONE. Without that it could rewrite the subject of a
-- notification, which is a way to put words in Helm's mouth about an export.
-- RLS cannot express a column restriction; a GRANT can.
--
-- AND THE REVOKE COMES FIRST, because 0220's ALTER DEFAULT PRIVILEGES has
-- already granted helm_app full DML on every table a later migration creates.
-- Without the revoke the column grant below restricts nothing at all — the
-- third time this has caught something (0680's node_view_stat, 0690's
-- task_reminder, now this), which is why the guard asserts it rather than
-- trusting the order of the statements.
-- =============================================================================
REVOKE ALL ON user_notification FROM helm_app;
REVOKE ALL ON user_notification FROM helm_worker;

GRANT SELECT ON user_notification TO helm_app;
GRANT UPDATE (read_at) ON user_notification TO helm_app;
-- Deleting one's own is the "clear" button, and it is the owner's row.
GRANT DELETE ON user_notification TO helm_app;

GRANT EXECUTE ON FUNCTION helm.notification_kinds() TO helm_app, helm_worker;
GRANT EXECUTE ON FUNCTION helm.default_notification_kinds() TO helm_app, helm_worker;
GRANT EXECUTE ON FUNCTION helm.notification_kind_for_event(text) TO helm_app, helm_worker;
GRANT EXECUTE ON FUNCTION helm.notification_kind_enabled(uuid, uuid, text)
  TO helm_app, helm_worker;
GRANT EXECUTE ON FUNCTION helm.notification_audience(uuid, text) TO helm_worker;
GRANT EXECUTE ON FUNCTION helm.unread_notification_count() TO helm_app;
GRANT EXECUTE ON FUNCTION helm.my_notifications(integer) TO helm_app;

-- =============================================================================
-- Retention
--
-- A BELL IS NOT AN ARCHIVE. The audit log is the archive and is append-only by
-- design; this table is a working surface, and left alone it grows by one row
-- per oversight event per subscribed administrator forever. Read rows go after
-- 30 days, unread after 180 — unread kept far longer because deleting
-- something somebody has not seen is deleting the thing the table exists for.
--
-- Called from the fan-out's own job rather than given a schedule of its own:
-- the sweep is cheap, it is bounded, and a thirteenth lock key for a DELETE
-- that runs in milliseconds is a worse trade than one extra statement.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.prune_notifications() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  DELETE FROM user_notification
  WHERE tenant_id = v_tenant
    AND (
      (read_at IS NOT NULL AND created_at < now() - interval '30 days')
      OR (read_at IS NULL AND created_at < now() - interval '180 days')
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION helm.prune_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.prune_notifications() TO helm_worker;

-- =============================================================================
-- The client purge counts notifications too
--
-- Reissued for the fourth time (0500, 0520, 0640, now this), which is the
-- standing cost of a count that enumerates tables by hand. 0500 argued the
-- alternative and rejected it: a count derived from the catalogue would quietly
-- include join tables and audit projections nobody means, and would read as
-- authoritative while being wrong in a different direction.
--
-- Everything here is 0640's, byte for byte, except one count and the comment
-- above it. The DELETEs are untouched — user_notification.organization_id is ON
-- DELETE CASCADE, so the rows go on their own; it is the number quoted back to
-- somebody before they destroy a client that needed telling.
-- =============================================================================

CREATE OR REPLACE FUNCTION helm.delete_organization(p_organization_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := helm.require_tenant_id();
  v_org     organization%ROWTYPE;
  v_counts  jsonb;
BEGIN
  SELECT * INTO v_org FROM organization
  WHERE id = p_organization_id AND tenant_id = v_tenant;

  IF NOT FOUND OR NOT helm.org_in_scope(p_organization_id) THEN
    RAISE EXCEPTION 'helm: client % not found', p_organization_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT helm.has_permission('organization:delete') THEN
    PERFORM helm.audit('organization.delete_denied', 'organization', p_organization_id,
                       'denied'::audit_outcome, p_organization_id, NULL, NULL,
                       jsonb_build_object('cause', 'missing_permission'));
    RAISE EXCEPTION 'helm: organization:delete is required to delete a client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_org.archived_at IS NULL THEN
    RAISE EXCEPTION 'helm: % must be archived before it can be deleted', v_org.name
      USING ERRCODE = 'check_violation', DETAIL = 'archive_first';
  END IF;

  -- `notifications` is new in this count, and `checklist_runs` was new in
  -- 0640's. The confirmation dialog quotes these numbers back before anything
  -- is destroyed, and "and 14 completed checklist runs" is exactly the kind of
  -- thing somebody should be told they are about to lose. Measured before any
  -- delete, like the rest.
  --
  -- The notifications themselves need no DELETE below: user_notification's
  -- organization_id is ON DELETE CASCADE, so they go with the client. It is the
  -- COUNT that has to be told, or the dialog understates what it destroys —
  -- and the audit row written from these counts would be wrong forever.
  SELECT jsonb_build_object(
    'assets',         (SELECT count(*) FROM asset_node WHERE organization_id = p_organization_id),
    'secrets',        (SELECT count(*) FROM secret     WHERE organization_id = p_organization_id),
    'sites',          (SELECT count(*) FROM site       WHERE organization_id = p_organization_id),
    'contacts',       (SELECT count(*) FROM contact    WHERE organization_id = p_organization_id),
    'notes',          (SELECT count(*) FROM note       WHERE organization_id = p_organization_id),
    'attachments',    (SELECT count(*) FROM attachment WHERE organization_id = p_organization_id),
    'checklist_runs', (SELECT count(*) FROM sop_run    WHERE organization_id = p_organization_id),
    'notifications',  (SELECT count(*) FROM user_notification
                        WHERE organization_id = p_organization_id)
  ) INTO v_counts;

  PERFORM helm.audit('organization.deleted', 'organization', p_organization_id,
                     'success'::audit_outcome, p_organization_id, NULL, NULL,
                     v_counts || jsonb_build_object('name', v_org.name, 'slug', v_org.slug));

  -- Runs first. sop_run.sop_id is ON DELETE RESTRICT, so a procedure with a run
  -- against it cannot be removed while the run exists — and the run is this
  -- client's, so it goes with them. sop_run_step follows by cascade.
  DELETE FROM sop_run WHERE organization_id = p_organization_id;

  -- Then the published versions, inside their own window. Narrow on purpose:
  -- the only sop_version rows reachable here are those of procedures belonging
  -- to the client being purged.
  PERFORM set_config('helm.purging', 'on', true);
  DELETE FROM sop_version
   WHERE sop_id IN (SELECT id FROM asset_node
                     WHERE organization_id = p_organization_id AND node_type = 'sop');
  PERFORM set_config('helm.purging', 'off', true);

  DELETE FROM asset_node WHERE organization_id = p_organization_id;
  DELETE FROM unifi_site_mapping WHERE organization_id = p_organization_id;

  -- Transaction-local, and lowered again immediately: the window in which
  -- credential history can be removed is exactly these two statements.
  PERFORM set_config('helm.purging', 'on', true);
  DELETE FROM secret_version
   WHERE secret_id IN (SELECT id FROM secret WHERE organization_id = p_organization_id);
  DELETE FROM secret WHERE organization_id = p_organization_id;
  PERFORM set_config('helm.purging', 'off', true);

  DELETE FROM organization WHERE id = p_organization_id;

  RETURN v_counts;
END;
$$;

-- =============================================================================
-- Raising a reminder no longer requires a mail relay
--
-- THE SECOND PLACE K'S EMAIL ASSUMPTION BLOCKED THE BELL, and the more serious
-- one. Both of 0690's reminder-raising functions carry
-- `JOIN smtp_setting m ON m.tenant_id = s.tenant_id AND m.enabled`, so in an
-- install with no relay configured NO task_reminder row is created at all —
-- and the trigger above, which is what lights the bell, never fires. An
-- air-gapped MSP would have had a bell that could not show the one thing it is
-- most for: the work assigned to the person looking at it.
--
-- That join was right when email was the only output. It is wrong with two
-- channels, and removing it is safe because 0690 already separated raising from
-- sending: helm.email_backlog() returns only tenants with an enabled relay, so
-- a reminder raised without one simply sits `pending` until somebody configures
-- mail — which is the behaviour 0690's own comment describes ("Left pending so
-- it goes out when somebody sets the relay up"). The relay gate belonged on
-- delivery, where it already is, and not on deciding that somebody should be
-- reminded.
--
-- THE PREFERENCE CHECK IS NOW ONE FUNCTION. Both of these inlined
-- `coalesce((SELECT p.kinds @> '["task_due"]'::jsonb ...), true)`, which was
-- correct and is now a third copy of a rule that 0700 split: the default is no
-- longer "everything on". helm.notification_kind_enabled() is the one place,
-- so the email sender, the trigger and these two cannot drift.
--
-- Everything else in both functions is 0690's, unchanged.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.raise_assignment_reminder(p_step_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := helm.require_tenant_id();
  v_rows   integer;
BEGIN
  INSERT INTO task_reminder (tenant_id, step_id, user_id, kind, lead_day)
  SELECT s.tenant_id, s.id, s.assigned_to, 'assigned', -1
  FROM sop_run_step s
  WHERE s.id = p_step_id
    AND s.tenant_id = v_tenant
    AND s.assigned_to IS NOT NULL
    -- Nobody needs a message saying they gave themselves a job.
    AND s.assigned_to <> coalesce(helm.current_actor_id(),
                                  '00000000-0000-0000-0000-000000000000'::uuid)
    AND helm.notification_kind_enabled(s.tenant_id, s.assigned_to, 'task_assigned')
  ON CONFLICT (step_id, kind, lead_day) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION helm.raise_task_reminders(p_limit integer DEFAULT 500)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_leads constant integer[] := ARRAY[3, 1, 0];
  v_raised integer := 0;
BEGIN
  WITH candidate AS (
    SELECT s.id AS step_id, s.tenant_id, s.assigned_to, s.due_at,
           -- Every threshold this step has crossed, smallest first.
           (SELECT array_agg(l ORDER BY l)
              FROM unnest(v_leads) l
             WHERE s.due_at <= now() + make_interval(days => l)) AS crossed
    FROM sop_run_step s
    JOIN sop_run r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
    WHERE s.assigned_to IS NOT NULL
      AND s.due_at IS NOT NULL
      AND s.status = 'pending'
      AND r.status IN ('in_progress', 'blocked')
      -- The person has to want it. One function decides, for both channels.
      AND helm.notification_kind_enabled(s.tenant_id, s.assigned_to, 'task_due')
      -- And still be a member, because the reminder's foreign key says so and
      -- because work assigned to somebody who left is not a reminder, it is a
      -- reassignment somebody has to do.
      -- `status = 'active'` AND an unexpired membership, which is the same
      -- pair listAssignableUsers() uses (0650). membership has no is_active
      -- column; the first version of this assumed one and failed on every row.
      AND EXISTS (
        SELECT 1 FROM membership mb
        WHERE mb.tenant_id = s.tenant_id AND mb.user_id = s.assigned_to
          AND mb.status = 'active'
          AND (mb.expires_at IS NULL OR mb.expires_at > now())
      )
    ORDER BY s.due_at
    LIMIT greatest(p_limit, 1)
  ),
  queued AS (
    INSERT INTO task_reminder (tenant_id, step_id, user_id, kind, lead_day, status)
    SELECT c.tenant_id, c.step_id, c.assigned_to, 'due', l,
           -- The smallest crossed threshold is the one that is sent. Everything
           -- larger is recorded as deliberately skipped.
           CASE WHEN l = c.crossed[1] THEN 'pending' ELSE 'suppressed' END
    FROM candidate c
    CROSS JOIN unnest(c.crossed) l
    ON CONFLICT (step_id, kind, lead_day) DO NOTHING
    RETURNING status
  )
  SELECT count(*) FILTER (WHERE status = 'pending') INTO v_raised FROM queued;

  RETURN v_raised;
END;
$$;

-- =============================================================================
-- helm.notification_fanout_backlog — which tenants the fan-out must visit
--
-- A PRE-EXISTING BUG, FOUND BY BUILDING ON TOP OF IT, and the most serious
-- thing this migration touches. `fanOutNotifications` in
-- src/workers/notifications.ts enumerated its tenants with a RAW query:
--
--     SELECT ... FROM tenant t
--     WHERE t.status = 'active'
--       AND helm.worker_actor(t.id, 'system_alerts') IS NOT NULL
--       AND EXISTS (SELECT 1 FROM webhook_endpoint e WHERE ...)
--
-- run on the bare worker pool. `tenant` is behind RLS —
-- `tenant_rls_select: id = helm.current_tenant_id()` — and a bare worker
-- connection holds no tenant context, so that query returns ZERO ROWS on every
-- tick. The audit fan-out has therefore never queued anything from the job;
-- 0400 removed two-person approval from credential exports on the stated
-- understanding that this notification replaces it, so the control it traded
-- for was not running.
--
-- WHY NOTHING CAUGHT IT. Every test of the fan-out calls
-- helm.fan_out_notifications() directly inside withTenant() — which is the
-- right way to test what the FUNCTION does, and skips the enumeration
-- entirely. The job's own tenant discovery had no test at all. This is the
-- third zero-rows-under-RLS defect in this project (H's refresh worker wrote
-- nothing and reported success; §49 and §50 of security.sql record the other
-- two), and the first one in a READ, where there is no write to come back empty
-- and nothing to notice.
--
-- THE FIX IS THE HOUSE PATTERN, which every other backlog already follows:
-- helm.alert_backlog(), helm.notification_backlog(), helm.email_backlog() and
-- helm.external_check_backlog() are all SECURITY DEFINER functions for exactly
-- this reason — "the worker holds no tenant context of its own, so it asks
-- which tenants to iterate and then enters each one", as 0420's own comment
-- puts it two functions further down the same file.
-- =============================================================================
CREATE OR REPLACE FUNCTION helm.notification_fanout_backlog(p_limit integer DEFAULT 50)
  RETURNS TABLE (tenant_id uuid, tenant_name text, worker_actor_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
  SELECT t.id, t.name, helm.worker_actor(t.id, 'system_alerts')
  FROM tenant t
  WHERE t.status = 'active'
    AND helm.worker_actor(t.id, 'system_alerts') IS NOT NULL
    -- 0420's pre-filter, kept: a tenant with nowhere to send anything need not
    -- be entered. 0700 adds the second half — somebody subscribed to an
    -- in-app oversight kind is also somewhere to send something, and an
    -- endpoint-only test would skip every tenant that wanted a bell and no
    -- webhook.
    AND (
      EXISTS (SELECT 1 FROM webhook_endpoint e
               WHERE e.tenant_id = t.id AND e.is_active)
      OR helm.has_inapp_audience(t.id)
    )
  ORDER BY t.name
  LIMIT greatest(p_limit, 1);
$$;

COMMENT ON FUNCTION helm.notification_fanout_backlog(integer) IS
  'Which tenants the audit fan-out must visit. SECURITY DEFINER because the '
  'worker holds no tenant context and `tenant` is behind RLS — the raw query '
  'this replaces returned zero rows on every tick, so the fan-out never ran.';

REVOKE ALL ON FUNCTION helm.notification_fanout_backlog(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helm.notification_fanout_backlog(integer) TO helm_worker;

-- =============================================================================
-- Guards
-- =============================================================================
DO $inapp_guard$
BEGIN
  -- 1. THE INBOX IS NOT WRITABLE FROM THE REQUEST PATH, except read_at. The
  --    load-bearing grant of this migration: without it somebody could forge a
  --    notification, or rewrite the subject of one about an export.
  IF has_table_privilege('helm_app', 'user_notification', 'INSERT') THEN
    RAISE EXCEPTION 'helm: helm_app can forge an in-app notification';
  END IF;
  IF has_column_privilege('helm_app', 'user_notification', 'subject', 'UPDATE')
    OR has_column_privilege('helm_app', 'user_notification', 'kind', 'UPDATE')
    OR has_column_privilege('helm_app', 'user_notification', 'href', 'UPDATE')
    OR has_column_privilege('helm_app', 'user_notification', 'user_id', 'UPDATE') THEN
    RAISE EXCEPTION
      'helm: helm_app can rewrite an in-app notification, not merely mark it read';
  END IF;
  -- ...and it CAN do the two things the bell needs.
  IF NOT has_column_privilege('helm_app', 'user_notification', 'read_at', 'UPDATE') THEN
    RAISE EXCEPTION 'helm: nothing can mark a notification read';
  END IF;
  IF NOT has_table_privilege('helm_app', 'user_notification', 'SELECT') THEN
    RAISE EXCEPTION 'helm: helm_app cannot read the bell it has to render';
  END IF;

  -- 2. AND NEITHER CAN THE WORKER, directly. The fan-out is SECURITY DEFINER;
  --    a worker holding INSERT could address a notification to anybody.
  IF has_table_privilege('helm_worker', 'user_notification', 'INSERT')
    OR has_table_privilege('helm_worker', 'user_notification', 'UPDATE') THEN
    RAISE EXCEPTION
      'helm: helm_worker must reach the inbox only through its definer functions';
  END IF;

  -- 3. AN INBOX IS PRIVATE, WITH NO audit:read CARVE-OUT. Asserted on the
  --    policy's text because that is the only thing making it so, and because
  --    0690 shipped exactly that carve-out on task_reminder and leaked to
  --    client_admin. What somebody has read is not oversight material.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'user_notification'
      AND p.polname = 'user_notification_rls_select'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%current_actor_id%'
  ) THEN
    RAISE EXCEPTION 'helm: an in-app notification must be readable only by its owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'user_notification'
      AND p.polname = 'user_notification_rls_select'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%audit:read%'
  ) THEN
    RAISE EXCEPTION
      'helm: audit:read must not open somebody else''s inbox — the audit log is '
      'where oversight reads belong';
  END IF;

  -- 4. RLS ON AND FORCED, with a policy per command.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'user_notification'
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'helm: user_notification needs RLS, forced';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname = 'user_notification') <> 4 THEN
    RAISE EXCEPTION 'helm: user_notification needs a policy per command';
  END IF;

  -- 5. THE AUDIENCE TESTS THE SCOPE AND NOT ONLY THE PERMISSION. Decision 31,
  --    which 0690 had to learn the hard way: client_admin holds audit:read.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'helm' AND p.proname = 'notification_audience'
      AND pg_get_functiondef(p.oid) LIKE '%org_scope_all%'
  ) THEN
    RAISE EXCEPTION
      'helm: the notification audience must require a tenant-wide seat, not '
      'merely audit:read';
  END IF;

  -- 6. THE FAN-OUT FILLS THE INBOX WITHOUT A DESTINATION. The whole point: an
  --    air-gapped tenant with no webhook and no relay still has a bell. If the
  --    in-app insert were ever joined to webhook_endpoint this would be the
  --    only thing that noticed.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'helm' AND p.proname = 'fan_out_notifications')
     NOT LIKE '%user_notification%' THEN
    RAISE EXCEPTION 'helm: the fan-out no longer fills the in-app inbox';
  END IF;

  -- 7. THE TWO KIND CATALOGUES AGREE, and the default is a subset of the legal
  --    set. A default naming a kind the CHECK refuses would make every
  --    preference row unwritable.
  IF NOT (SELECT helm.default_notification_kinds() <@ helm.notification_kinds()) THEN
    RAISE EXCEPTION 'helm: the default notification kinds are not all legal kinds';
  END IF;
  IF NOT helm.notification_kinds_valid(
      to_jsonb(helm.default_notification_kinds())) THEN
    RAISE EXCEPTION 'helm: the default notification kinds do not pass the validator';
  END IF;
  -- 0690's two must still be legal: a tenant that stored them before this
  -- migration has rows that would otherwise violate the reissued CHECK.
  IF NOT ('task_assigned' = ANY (helm.notification_kinds())
          AND 'task_due' = ANY (helm.notification_kinds())) THEN
    RAISE EXCEPTION 'helm: 0690''s notification kinds must remain legal';
  END IF;

  -- 8. EVERY EVENT EITHER MAPS TO A KIND OR IS DELIBERATELY SILENT. Asserted
  --    as a count rather than a list, so adding an event to
  --    notification_events() without deciding its in-app kind fails here
  --    instead of quietly never reaching a bell.
  IF EXISTS (
    SELECT 1 FROM unnest(helm.notification_events()) AS e(event)
    WHERE helm.notification_kind_for_event(e.event) IS NULL
  ) THEN
    RAISE EXCEPTION
      'helm: % has no in-app notification kind; add one to '
      'notification_kind_for_event or it will never reach a bell',
      (SELECT string_agg(e.event, ', ') FROM unnest(helm.notification_events()) AS e(event)
        WHERE helm.notification_kind_for_event(e.event) IS NULL);
  END IF;

  -- 9. A REMINDER LIGHTS THE BELL BY A TRIGGER, not by two call sites.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'task_reminder_notify' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'helm: a task reminder must mirror into the in-app inbox';
  END IF;

  -- 9b. RAISING A REMINDER DOES NOT REQUIRE A MAIL RELAY. 0690's versions
  --     joined smtp_setting, so an install with no relay created no reminders
  --     at all and the bell could never show the one thing it is most for. The
  --     relay gate belongs on delivery (helm.email_backlog), where it still is.
  IF (SELECT pg_get_functiondef('helm.raise_task_reminders(integer)'::regprocedure))
       LIKE '%smtp_setting%'
    OR (SELECT pg_get_functiondef('helm.raise_assignment_reminder(uuid)'::regprocedure))
       LIKE '%smtp_setting%' THEN
    RAISE EXCEPTION
      'helm: raising a reminder must not depend on a mail relay — the in-app '
      'bell has no relay to depend on';
  END IF;
  -- ...and delivery still does, or an air-gapped tenant would burn attempts.
  IF (SELECT pg_get_functiondef('helm.email_backlog(integer)'::regprocedure))
     NOT LIKE '%smtp_setting%' THEN
    RAISE EXCEPTION 'helm: email delivery must still require an enabled relay';
  END IF;

  -- 9c. THE FAN-OUT'S TENANT ENUMERATION IS A DEFINER FUNCTION. The bug this
  --     migration found: a raw SELECT over `tenant` from the worker pool
  --     returns zero rows under RLS, so the job never ran. Asserted on
  --     prosecdef rather than on existence, because a non-definer function of
  --     the same name would have the identical defect.
  IF NOT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'helm' AND p.proname = 'notification_fanout_backlog') THEN
    RAISE EXCEPTION
      'helm: the fan-out backlog must be SECURITY DEFINER — the worker holds no '
      'tenant context and `tenant` is behind RLS';
  END IF;

  -- 10. AND THE PURGE COUNT KNOWS ABOUT THE NEW TABLE. The counts become an
  --     audit row and a confirmation dialog, so one that undercounts is a
  --     dialog that understates what it is about to destroy — permanently, in
  --     the record of the deletion.
  IF (SELECT pg_get_functiondef('helm.delete_organization(uuid)'::regprocedure))
     NOT LIKE '%user_notification%' THEN
    RAISE EXCEPTION 'helm: the client purge does not count in-app notifications';
  END IF;
END;
$inapp_guard$;
