/**
 * The organization drawer's taxonomy.
 *
 * MAPPED ONTO HELM'S SCHEMA, NOT INVENTED. Each entry below resolves to rows
 * that already exist — a node_type in `asset_node`, or one of the three tables
 * that are not nodes (`site`, `contact`, `attachment`). A category that had no
 * backing query would render a count of nothing and route to an empty page,
 * which is the kind of navigation that teaches people not to trust the sidebar.
 *
 * WHY THERE IS NO "CHECKLISTS" ITEM beside SOPs. The sentence here used to say
 * "Checklists. There is no table for a recurring task list", and neither half
 * is true any more — 0090 has modelled procedures, published versions and runs
 * since the schema was written, the application creates them under SOPs, and
 * since 0770 a schedule on a procedure raises runs on its own. A "Checklists"
 * item would route to the same rows SOPs already lists; the schedules live on
 * each procedure's page, where the steps they raise are.
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
  /**
   * Not in the DEFAULT primary list, so it starts under "More".
   *
   * It used to be the whole answer: the drawer filtered on this flag and the
   * split was the same for every tenant. Since 0620 the split is a per-user
   * list (src/lib/nav/sidebar-layout.ts) and this flag decides only what
   * somebody sees before they have arranged anything — which is why the
   * default is still exactly today's drawer. Promoting a category here changes
   * the default; it does not move it for anybody who has already chosen.
   */
  secondary?: boolean;
}

export const ORG_CATEGORIES: readonly OrgCategory[] = [
  { slug: 'configurations', label: 'Configurations', kind: 'node',  source: 'device',          icon: 'Server' },
  { slug: 'contacts',       label: 'Contacts',       kind: 'table', source: 'contact',         icon: 'Users' },
  { slug: 'documents',      label: 'Documents',      kind: 'table', source: 'attachment',      icon: 'FileText' },
  { slug: 'domains',        label: 'Domain Tracker', kind: 'node',  source: 'domain',          icon: 'Globe' },
  { slug: 'locations',      label: 'Locations',      kind: 'table', source: 'site',            icon: 'MapPin' },
  { slug: 'networks',       label: 'Networks',       kind: 'node',  source: 'network',         icon: 'Network' },
  // Labelled Credentials; the slug stays 'passwords' so saved links, sidebar
  // layouts (helm.sidebar_layout_valid) and bookmarks keep working.
  { slug: 'passwords',      label: 'Credentials',    kind: 'node',  source: 'credential',      icon: 'KeyRound' },
  { slug: 'ssl',            label: 'SSL Tracker',    kind: 'node',  source: 'ssl_certificate', icon: 'ShieldCheck' },

  // The rest of Helm's node types. Real, less often reached, and therefore
  // behind "More" BY DEFAULT — which is what IT Glue's own footer menu is for,
  // and what anybody can now change for themselves.
  { slug: 'applications', label: 'Applications', kind: 'node', source: 'application',       icon: 'AppWindow',  secondary: true },
  { slug: 'directories',  label: 'Directories',  kind: 'node', source: 'directory_service', icon: 'FolderTree', secondary: true },
  { slug: 'circuits',     label: 'ISP Circuits', kind: 'node', source: 'isp_circuit',       icon: 'Cable',      secondary: true },
  { slug: 'contracts',    label: 'Contracts',    kind: 'node', source: 'contract',          icon: 'FileSignature', secondary: true },
  { slug: 'licenses',     label: 'Licences',     kind: 'node', source: 'license',           icon: 'BadgeCheck', secondary: true },
  { slug: 'vendors',      label: 'Vendors',      kind: 'node', source: 'vendor',            icon: 'Truck',      secondary: true },
  { slug: 'sops',         label: 'SOPs',         kind: 'node', source: 'sop',               icon: 'BookOpen',   secondary: true },
  // No 'ip-addresses'. The ip_address node type still exists in the schema and
  // an existing row still opens, but an address belongs on the network or the
  // device that holds it, not in a list of its own; the category was retired
  // rather than kept as a second place to record the same fact.
];

/**
 * Which create form "+ New" opens on a category page, or null for none.
 *
 * ONE ANSWER RATHER THAN FIVE CONDITIONS. CategoryActions used to test each
 * form's condition independently, and the generic asset form's condition was
 * "this category has a node_type" — which is true of SOPs, because a procedure
 * IS an asset_node of type 'sop'. That needed a `category !== 'sops'` guard
 * standing between a right screen and a wrong one, and nothing but the guard's
 * own comment said so. A function that returns ONE form cannot render two, so
 * the class of bug is gone rather than guarded against.
 *
 * It is here, beside the taxonomy, because the answer is a property of the
 * category: 'passwords' means a credential whatever page is asking.
 */
export type CreateForm = 'contact' | 'secret' | 'site' | 'procedure' | 'configuration' | 'asset';

export function createFormFor(category: string, nodeType?: string | undefined): CreateForm | null {
  switch (category) {
    case 'contacts': return 'contact';
    // A device has the sectioned form (0800); the generic one asks only for
    // a name and a type, which is not how anybody documents a server.
    case 'configurations': return 'configuration';
    case 'passwords': return 'secret';
    case 'locations': return 'site';
    case 'sops': return 'procedure';
    default:
      // Every remaining node category shares one form, pinned to its type.
      // 'documents' is a file upload and has no node_type, so it lands here
      // with nothing to offer — which is why Import exists on that category
      // and + New does not.
      return nodeType ? 'asset' : null;
  }
}

const BY_SLUG = new Map(ORG_CATEGORIES.map((c) => [c.slug, c]));

export function categoryBySlug(slug: string): OrgCategory | undefined {
  return BY_SLUG.get(slug);
}

/*
 * The same taxonomy read the other way: given a node_type or a table name,
 * which category is it?
 *
 * The "Recently updated" widget knows what a row IS — `asset_node.node_type`,
 * or the table it came out of — and needs a word for it and somewhere to send
 * a reader. Deriving both from this list rather than from humanise() means the
 * widget says "SSL Tracker" and "Licences" exactly as the sidebar does, instead
 * of "Ssl certificate" and "License" beside it on the same page.
 *
 * Returns undefined for a source with no category, which today is
 * `flexible_asset`: those are the tenant's own types and the sidebar lists them
 * individually, so there is no one entry to point at. Callers fall back.
 */
const BY_SOURCE = new Map(ORG_CATEGORIES.map((c) => [c.source, c]));

export function categoryBySource(source: string): OrgCategory | undefined {
  return BY_SOURCE.get(source);
}

/** Counts keyed by slug, plus one entry per flexible asset type keyed by `fa:<id>`. */
export type CategoryCounts = Record<string, number>;
