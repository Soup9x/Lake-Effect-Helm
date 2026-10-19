/**
 * Which client a page is about, for "search this client".
 *
 * DERIVED FROM THE ROUTE, as the shell derives everything about the current
 * organization (see shell-context.tsx). Most pages say it in the path —
 * /organizations/:id/… — and the rest name one record that belongs to exactly
 * one client: an asset, a contact, a written document, a checklist run. Those
 * are looked up here, UNDER RLS, so a path naming something the reader cannot
 * see resolves to no client rather than to somebody else's.
 *
 * Anything else — the dashboard, settings — is not inside a client, and the
 * search box offers only "All clients" there.
 */
import type { HelmTx } from '../db/client';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const ROUTES: readonly { pattern: RegExp; table: 'organization' | 'asset_node' | 'contact' | 'document_page' | 'sop_run' }[] = [
  { pattern: new RegExp(`^/organizations/(${UUID})(?:/|$)`), table: 'organization' },
  { pattern: new RegExp(`^/assets/(${UUID})(?:/|$)`), table: 'asset_node' },
  { pattern: new RegExp(`^/contacts/(${UUID})(?:/|$)`), table: 'contact' },
  { pattern: new RegExp(`^/documents/(${UUID})(?:/|$)`), table: 'document_page' },
  { pattern: new RegExp(`^/runs/(${UUID})(?:/|$)`), table: 'sop_run' },
];

export interface ClientScope {
  id: string;
  name: string;
}

export async function clientForPath(tx: HelmTx, path: string): Promise<ClientScope | null> {
  for (const route of ROUTES) {
    const id = route.pattern.exec(path)?.[1];
    if (!id) continue;
    const [row] = route.table === 'organization'
      ? await tx<ClientScope[]>`SELECT id, name FROM organization WHERE id = ${id}::uuid`
      : await tx<ClientScope[]>`
          SELECT o.id, o.name FROM ${tx(route.table)} r
          JOIN organization o ON o.id = r.organization_id
          WHERE r.id = ${id}::uuid
        `;
    return row ?? null;
  }
  return null;
}
