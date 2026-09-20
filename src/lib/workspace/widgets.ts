/**
 * The dashboard's widget catalogue.
 *
 * WIDGET_KEYS must match helm.dashboard_layout_valid() in
 * db/sql/0370_workspace_and_notes.sql. Two copies of one list is a cost paid
 * deliberately: the database refuses an unknown key so a malformed layout is
 * never stored, and the interface needs the titles anyway. The test in
 * tests/integration/workspace.test.ts asserts the two lists agree, so adding a
 * widget here without a migration fails there rather than at somebody's desk.
 */
export const WIDGET_KEYS = [
  'favorites',
  'recently_viewed',
  'expirations',
  'audit_activity',
  'client_health',
  'quick_actions',
  'usage_summary',
  'sync_status',
] as const;

export type WidgetKey = (typeof WIDGET_KEYS)[number];

export interface WidgetMeta {
  key: WidgetKey;
  title: string;
  description: string;
}

export const WIDGETS: Record<WidgetKey, WidgetMeta> = {
  favorites: {
    key: 'favorites',
    title: 'Pinned clients',
    description: 'The clients you starred, so the four you actually work on are one click away.',
  },
  recently_viewed: {
    key: 'recently_viewed',
    title: 'Recently viewed',
    description: 'What you opened last, newest first — how you get back to yesterday’s ticket.',
  },
  expirations: {
    key: 'expirations',
    title: 'Upcoming expirations',
    description: 'Certificates, warranties and licences approaching their date.',
  },
  audit_activity: {
    key: 'audit_activity',
    title: 'Recent activity',
    description: 'The last things anybody did in this tenant.',
  },
  client_health: {
    key: 'client_health',
    title: 'Client health',
    description: 'Red, amber and green across every client you can see.',
  },
  quick_actions: {
    key: 'quick_actions',
    title: 'Quick actions',
    description: 'Start a client, a credential, a site or an asset without navigating to one first.',
  },
  usage_summary: {
    key: 'usage_summary',
    title: 'What is documented',
    description: 'Totals across everything you can see — clients, credentials, assets, sites.',
  },
  sync_status: {
    key: 'sync_status',
    title: 'Network sync',
    description: 'Each UniFi controller Helm polls, and when it last answered.',
  },
};

/**
 * What a first-time user gets.
 *
 * Deliberately not every widget. A dashboard that opens with five panels is one
 * somebody has to dismantle before it is useful; these four answer "what needs
 * me today" and "where was I", which is what somebody opens Helm for. The fifth
 * is one click away in the customise control.
 */
export const DEFAULT_LAYOUT: WidgetKey[] = [
  'favorites',
  'recently_viewed',
  'expirations',
  'client_health',
];

const KNOWN = new Set<string>(WIDGET_KEYS);

export function isWidgetKey(value: unknown): value is WidgetKey {
  return typeof value === 'string' && KNOWN.has(value);
}

/**
 * Read a layout out of the database, tolerating anything.
 *
 * The CHECK constraint means a stored layout is already valid, so this exists
 * for the row that predates a widget being RETIRED: a key removed from the
 * catalogue is still in somebody's saved layout, and the dashboard must drop it
 * rather than render a hole or throw. Dropping is safe — the customise control
 * writes the layout back the next time they touch it.
 */
export function readLayout(stored: unknown): WidgetKey[] {
  if (!Array.isArray(stored)) return [...DEFAULT_LAYOUT];
  const seen = new Set<WidgetKey>();
  for (const value of stored) if (isWidgetKey(value)) seen.add(value);
  return [...seen];
}

/**
 * Move the widget at `from` so it sits at `to`.
 *
 * ONE definition, used by both the drag handler and the arrow buttons. They are
 * two affordances over the same operation, and the bug they would otherwise
 * develop is subtle: an arrow that splices before removing, or a drop that
 * computes its target index against the pre-removal array, moves the item one
 * place too far in one direction only. Writing it once means the arrows are a
 * keyboard interface to exactly what dragging does.
 *
 * Out-of-range indices return the list unchanged rather than throwing. A drag
 * that ends outside the list and an arrow pressed at the end are both ordinary
 * events, not errors.
 */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...list];
  if (from < 0 || from >= list.length) return [...list];
  if (to < 0 || to >= list.length) return [...list];

  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
