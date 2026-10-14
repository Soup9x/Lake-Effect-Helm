-- =============================================================================
-- 0600 — an organisation's RELATIONSHIP, which is not its lifecycle
--
-- The clients list needs a Type column: is this a client, a prospect, a vendor,
-- a competitor, us, or something else. Helm had no such column, and two
-- existing columns look at first glance like they already answer it. Neither
-- does, and the interesting part of this migration is why.
--
-- `status` IS A LIFECYCLE, NOT A RELATIONSHIP.
--
--   prospect, onboarding, active, co_managed, offboarding, former
--
-- Those are stages a relationship passes THROUGH. Note what you cannot say
-- with them: a prospect you have stopped pursuing. `status = 'former'` loses
-- the fact that it was a prospect and not a client; `status = 'prospect'`
-- claims you are still chasing it. The two facts are genuinely independent,
-- which is the test for whether a second column is duplication or modelling.
--
-- So `prospect` appears in BOTH enums on purpose, and there is deliberately no
-- CHECK tying them together. The first draft of this migration had
--
--     CHECK ((type = 'prospect') = (status = 'prospect'))
--
-- which is wrong, and the case above is what proves it: type 'prospect' with
-- status 'former' is a prospect that went cold, and the constraint forbids
-- recording it. After the backfill below the two agree; from then on they move
-- independently, because they describe different things.
--
-- `is_msp_internal` IS STRUCTURAL, NOT A LABEL.
--
-- 0010 put a unique index on it: AT MOST ONE per tenant. It means "this row is
-- us", it is not settable through the API, and the asset graph leans on there
-- being exactly one. ITG's Internal type is an ordinary label you could apply
-- to several organisations.
--
-- So this migration does NOT replace it and does NOT widen it. The backfill
-- seeds `type = 'internal'` where it is set, and the implication runs one way
-- for good: the MSP's own organisation is always type 'internal', but marking
-- an organisation type 'internal' does not make it the MSP. Keeping both is
-- the cheaper mistake — folding them together would mean either losing the
-- one-per-tenant guarantee or forbidding a second internal department.
--
-- WHY `other` EXISTS. A relationship enum without an escape hatch gets abused:
-- somebody files a managed service provider they subcontract to under 'vendor'
-- because nothing else fits, and the Type column stops meaning anything. One
-- honest 'other' is better than five dishonest 'vendor's.
--
-- RLS: none needed. `organization` is already covered by its 0200 policies and
-- this adds a column to it, not a table.
-- =============================================================================

CREATE TYPE organization_relationship AS ENUM (
  'client',
  'prospect',
  'vendor',
  'competitor',
  'internal',
  'other'
);

ALTER TABLE organization
  ADD COLUMN relationship organization_relationship NOT NULL DEFAULT 'client';

-- -----------------------------------------------------------------------------
-- Backfill, most specific signal first.
--
-- Ordering matters: the MSP's own organisation could in principle also carry
-- status 'prospect' (nothing forbids it), and "us" is the more useful answer.
-- Everything else keeps the column default of 'client', which is what every row
-- in a Helm install today actually is.
-- -----------------------------------------------------------------------------
UPDATE organization SET relationship = 'prospect' WHERE status = 'prospect';
UPDATE organization SET relationship = 'internal' WHERE is_msp_internal;

-- Partial, because the list filters by relationship within the live rows only
-- and an index that also spans archived and deleted organisations is read less
-- often than it is maintained.
CREATE INDEX organization_tenant_relationship_idx
  ON organization (tenant_id, relationship)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

COMMENT ON COLUMN organization.relationship IS
  'What this organisation is to the MSP. Independent of status, which is the '
  'lifecycle stage: relationship ''prospect'' with status ''former'' is a '
  'prospect that went cold. Implied by is_msp_internal but not equivalent to '
  'it — that column is unique per tenant and means "this row is us".';

COMMENT ON TYPE organization_relationship IS
  'The relationship, not the lifecycle. See organization.status for the stage.';
