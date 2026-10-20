/**
 * The Global tab's Assets and Configurations lists: every client's entries in
 * one grid, narrowed by filters that live in the URL.
 *
 * READ UNDER RLS like every list. An MSP technician sees every client they are
 * scoped to; a client-side user who reaches these pages sees their own client
 * only, which is the same list their client page already shows. Nothing here
 * widens what anybody can read — it puts what they can read side by side.
 *
 * CREDENTIALS ARE NOT "ASSETS" HERE. A cross-client list of logins is a target
 * list, and the Passwords tab of each client, with its per-entry access policy,
 * is where they are meant to be read. Search still finds them.
 */
import type { HelmTx } from '../db/client';
import { isUuid } from '../ids';
import { NODE_STATUSES } from '../assets/statuses';
import { DEVICE_TYPES } from '../assets/detail-fields';
import { ORG_CATEGORIES } from '../nav/org-categories';

/** The node types the Assets list offers: every asset category but credentials. */
export const GLOBAL_ASSET_TYPES: readonly { value: string; label: string }[] = [
  ...ORG_CATEGORIES
    .filter((c) => c.kind === 'node' && c.source !== 'credential')
    .map((c) => ({ value: c.source, label: c.label })),
  { value: 'flexible_asset', label: 'Apps & Services' },
];

const ASSET_TYPE_SET = new Set(GLOBAL_ASSET_TYPES.map((t) => t.value));
const STATUS_SET = new Set<string>(NODE_STATUSES);
const DEVICE_TYPE_SET = new Set<string>(DEVICE_TYPES);

/** The most rows one view returns; the page says so when it is hit. */
export const GLOBAL_LIST_LIMIT = 1000;

export interface GlobalFilters {
  client: string | null;
  type: string | null;
  status: string | null;
  site: string | null;
  view: 'all' | 'shared' | 'internal';
  archived: boolean;
}

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

/**
 * The URL, read into filters. Anything that is not a value this list knows is
 * dropped rather than refused: a stale link should still open the list, just
 * wider than it was.
 */
export function readGlobalFilters(search: Search, types: ReadonlySet<string>): GlobalFilters {
  const client = one(search.client);
  const site = one(search.site);
  const type = one(search.type);
  const status = one(search.status);
  const view = one(search.view);
  return {
    client: client && isUuid(client) ? client : null,
    // A location belongs to one client, so it only narrows within one.
    site: client && isUuid(client) && site && isUuid(site) ? site : null,
    type: type && types.has(type) ? type : null,
    status: status && STATUS_SET.has(status) ? status : null,
    view: view === 'shared' || view === 'internal' ? view : 'all',
    archived: one(search.archived) === '1',
  };
}

export const readAssetFilters = (search: Search) => readGlobalFilters(search, ASSET_TYPE_SET);
export const readConfigurationFilters = (search: Search) => readGlobalFilters(search, DEVICE_TYPE_SET);

export interface GlobalRow {
  id: string;
  name: string;
  organization_id: string;
  organization_name: string;
  site_name: string | null;
  status: string;
  is_internal_only: boolean;
  archived: boolean;
  updated_at: Date;
  updated_by_name: string | null;
}

export interface GlobalAssetRow extends GlobalRow {
  node_type: string;
  flexible_type_name: string | null;
}

export interface GlobalConfigurationRow extends GlobalRow {
  device_type: string;
  operating_system: string | null;
  os_version: string | null;
  primary_ip: string | null;
  serial_number: string | null;
  warranty_expires_at: Date | null;
}

function common(tx: HelmTx, f: GlobalFilters) {
  return tx`
    ${f.client ? tx`AND n.organization_id = ${f.client}::uuid` : tx``}
    ${f.site ? tx`AND n.site_id = ${f.site}::uuid` : tx``}
    ${f.status ? tx`AND n.status = ${f.status}::node_status` : tx``}
    ${f.view === 'all' ? tx`` : tx`AND n.is_internal_only = ${f.view === 'internal'}`}
    ${f.archived ? tx`` : tx`AND n.archived_at IS NULL`}
  `;
}

export async function listGlobalAssets(tx: HelmTx, f: GlobalFilters): Promise<GlobalAssetRow[]> {
  const types = f.type ? [f.type] : [...ASSET_TYPE_SET];
  return tx<GlobalAssetRow[]>`
    SELECT n.id, n.name, n.organization_id, o.name AS organization_name, s.name AS site_name,
           n.node_type::text, t.name AS flexible_type_name, n.status::text, n.is_internal_only,
           n.archived_at IS NOT NULL AS archived, n.updated_at, u.name AS updated_by_name
    FROM asset_node n
    JOIN organization o ON o.id = n.organization_id
    LEFT JOIN site s ON s.id = n.site_id AND s.deleted_at IS NULL
    LEFT JOIN app_user u ON u.id = n.updated_by
    LEFT JOIN flexible_asset_record r ON r.id = n.id
    LEFT JOIN flexible_asset_type t ON t.id = r.type_id
    WHERE n.node_type = ANY (${types}::node_type[])
      ${common(tx, f)}
    ORDER BY lower(o.name), lower(n.name)
    LIMIT ${GLOBAL_LIST_LIMIT}
  `;
}

export async function listGlobalConfigurations(
  tx: HelmTx, f: GlobalFilters,
): Promise<GlobalConfigurationRow[]> {
  return tx<GlobalConfigurationRow[]>`
    SELECT n.id, n.name, n.organization_id, o.name AS organization_name, s.name AS site_name,
           n.status::text, n.is_internal_only, n.archived_at IS NOT NULL AS archived,
           n.updated_at, u.name AS updated_by_name,
           d.device_type::text, d.operating_system, d.os_version, host(d.primary_ip) AS primary_ip,
           d.serial_number, d.warranty_expires_at
    FROM asset_node n
    JOIN device d ON d.id = n.id
    JOIN organization o ON o.id = n.organization_id
    LEFT JOIN site s ON s.id = n.site_id AND s.deleted_at IS NULL
    LEFT JOIN app_user u ON u.id = n.updated_by
    WHERE n.node_type = 'device'
      ${f.type ? tx`AND d.device_type = ${f.type}::device_type` : tx``}
      ${common(tx, f)}
    ORDER BY lower(o.name), lower(n.name)
    LIMIT ${GLOBAL_LIST_LIMIT}
  `;
}

/** The pickers: clients this reader can see, and the chosen client's locations. */
export async function globalFilterOptions(tx: HelmTx, client: string | null) {
  const [clients, sites] = await Promise.all([
    tx<{ id: string; name: string }[]>`
      SELECT id, name FROM organization WHERE archived_at IS NULL ORDER BY lower(name)
    `,
    client
      ? tx<{ id: string; name: string }[]>`
          SELECT id, name FROM site
          WHERE organization_id = ${client}::uuid AND deleted_at IS NULL AND archived_at IS NULL
          ORDER BY lower(name)
        `
      : Promise.resolve([]),
  ]);
  return { clients, sites };
}
