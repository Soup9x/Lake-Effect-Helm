import { tenantRoute } from '@/lib/api/handler';
import { listRecent } from '@/lib/workspace/queries';

/**
 * What the acting user opened, newest first.
 *
 * Fetched when the popover opens rather than rendered into every page's shell.
 * The shell renders on every navigation, and a query per page load to populate
 * a control most people will not touch is a cost paid continuously for a
 * benefit taken occasionally. Fetching on open is also the only way the list is
 * guaranteed current: a layout and its page render concurrently, so a
 * server-rendered list would routinely be one navigation stale.
 */
export const GET = tenantRoute(async ({ tx }) => ({ recent: await listRecent(tx, 10) }));

export const dynamic = 'force-dynamic';
