/**
 * The organization drawer's taxonomy.
 *
 * MAPPED ONTO HELM'S SCHEMA, NOT INVENTED. Each entry below resolves to rows
 * that already exist — a node_type in `asset_node`, or one of the three tables
 * that are not nodes (`site`, `contact`, `attachment`). A category that had no
 * backing query would render a count of nothing and route to an empty page,
 * which is the kind of navigation that teaches people not to trust the sidebar.
 *
 * WHAT HAS NO HELM EQUIVALENT, and is therefore absent rather than stubbed:
 * Checklists. There is no table for a recurring task list; adding a nav item
 * for one would promise a feature that does not exist.
 *
 * `kind` is how the count and the listing are derived:
 *   'node'  — asset_node filtered to one node_type
 *   'table' — its own table, named by `source`
 */
export type CategoryKind = 'node' | 'table';

export interface OrgCategory {
  slug: string;
  label: string;
  kind: CategoryKind;
  /** A node_type for 'node', or a table name for 'table'. */
  source: string;
  /** lucide-react icon name, resolved by the client component. */
  icon: string;
  /** Shown under "More" rather than in the primary list. */
  secondary?: boolean;
}

export const ORG_CATEGORIES: readonly OrgCategory[] = [
  { slug: 'configurations', label: 'Configurations', kind: 'node',  source: 'device',          icon: 'Server' },
  { slug: 'contacts',       label: 'Contacts',       kind: 'table', source: 'contact',         icon: 'Users' },
  { slug: 'documents',      label: 'Documents',      kind: 'table', source: 'attachment',      icon: 'FileText' },
  { slug: 'domains',        label: 'Domain Tracker', kind: 'node',  source: 'domain',          icon: 'Globe' },
  { slug: 'locations',      label: 'Locations',      kind: 'table', source: 'site',            icon: 'MapPin' },
  { slug: 'networks',       label: 'Networks',       kind: 'node',  source: 'network',         icon: 'Network' },
  { slug: 'passwords',      label: 'Passwords',      kind: 'node',  source: 'credential',      icon: 'KeyRound' },
  { slug: 'ssl',            label: 'SSL Tracker',    kind: 'node',  source: 'ssl_certificate', icon: 'ShieldCheck' },

  // The rest of Helm's node types. Real, less often reached, and therefore
  // behind "More" — which is what IT Glue's own footer menu is for.
  { slug: 'applications', label: 'Applications', kind: 'node', source: 'application',       icon: 'AppWindow',  secondary: true },
  { slug: 'directories',  label: 'Directories',  kind: 'node', source: 'directory_service', icon: 'FolderTree', secondary: true },
  { slug: 'circuits',     label: 'ISP Circuits', kind: 'node', source: 'isp_circuit',       icon: 'Cable',      secondary: true },
  { slug: 'contracts',    label: 'Contracts',    kind: 'node', source: 'contract',          icon: 'FileSignature', secondary: true },
  { slug: 'licenses',     label: 'Licences',     kind: 'node', source: 'license',           icon: 'BadgeCheck', secondary: true },
  { slug: 'vendors',      label: 'Vendors',      kind: 'node', source: 'vendor',            icon: 'Truck',      secondary: true },
  { slug: 'sops',         label: 'SOPs',         kind: 'node', source: 'sop',               icon: 'BookOpen',   secondary: true },
  { slug: 'ip-addresses', label: 'IP Addresses', kind: 'node', source: 'ip_address',        icon: 'Binary',     secondary: true },
];

const BY_SLUG = new Map(ORG_CATEGORIES.map((c) => [c.slug, c]));

export function categoryBySlug(slug: string): OrgCategory | undefined {
  return BY_SLUG.get(slug);
}

/** Counts keyed by slug, plus one entry per flexible asset type keyed by `fa:<id>`. */
export type CategoryCounts = Record<string, number>;
