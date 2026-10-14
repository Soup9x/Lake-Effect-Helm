/**
 * What an organisation is to the MSP.
 *
 * RELATIONSHIP_KEYS must match the organization_relationship enum in
 * db/sql/0600_organization_relationship_type.sql. Two copies of one list is a
 * cost paid deliberately, for the same reason WIDGET_KEYS pays it: the
 * database refuses a value outside the enum so a bad write is impossible, and
 * the interface needs the labels anyway. The test in
 * tests/integration/organizations.test.ts asserts the two agree, so adding a
 * value here without a migration fails there rather than at somebody's desk.
 *
 * NOT THE SAME AXIS AS `status`. Status is the lifecycle — prospect,
 * onboarding, active, co_managed, offboarding, former. Relationship is what
 * the organisation IS. A prospect that went cold is relationship 'prospect',
 * status 'former', and neither column can say that alone.
 */
export const RELATIONSHIP_KEYS = [
  'client',
  'prospect',
  'vendor',
  'competitor',
  'internal',
  'other',
] as const;

export type Relationship = (typeof RELATIONSHIP_KEYS)[number];

/** The tone each relationship renders with, from the shared badge palette. */
type Tone = 'brand' | 'neutral' | 'warning' | 'ok';

interface RelationshipMeta {
  key: Relationship;
  label: string;
  tone: Tone;
  /** Shown in the picker, where "why would I choose this one" is the question. */
  hint: string;
}

export const RELATIONSHIPS: Record<Relationship, RelationshipMeta> = {
  client: {
    key: 'client',
    label: 'Client',
    tone: 'ok',
    hint: 'You document and support them. The default, and almost everything.',
  },
  prospect: {
    key: 'prospect',
    label: 'Prospect',
    tone: 'warning',
    hint: 'Not signed yet. Keep the status in step as the deal moves.',
  },
  vendor: {
    key: 'vendor',
    label: 'Vendor',
    tone: 'neutral',
    hint: 'You buy from them. Useful for holding portal credentials and contacts.',
  },
  competitor: {
    key: 'competitor',
    label: 'Competitor',
    tone: 'neutral',
    hint: 'Tracked, not supported — usually an incumbent you are displacing.',
  },
  internal: {
    key: 'internal',
    label: 'Internal',
    tone: 'brand',
    hint: 'Your own organisation or a department of it.',
  },
  other: {
    key: 'other',
    label: 'Other',
    tone: 'neutral',
    hint: 'None of the above. Better than filing something under a label that lies.',
  },
};

/** Falls back rather than throwing: a column read is not a validation site. */
export function relationshipOf(value: string | null | undefined): RelationshipMeta {
  return RELATIONSHIPS[(value ?? 'client') as Relationship] ?? RELATIONSHIPS.client;
}

/**
 * Which lifecycle stages count as "active" for the list's Status filter.
 *
 * ITG offers Active/Inactive. Helm's status enum is a six-stage superset, so
 * rather than throwing away the detail the column shows the real stage and the
 * FILTER groups them. co_managed is active: a co-managed client is one you are
 * actively working, just not alone.
 */
export const ACTIVE_STATUSES = ['onboarding', 'active', 'co_managed'] as const;

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}
