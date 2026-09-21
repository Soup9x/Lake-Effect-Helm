/**
 * Every page actually renders, against a real database.
 *
 * WHY THIS FILE EXISTS. `u.display_name AS uploaded_by_name` shipped to
 * production and broke EVERY client page with `column u.display_name does not
 * exist`. app_user has `name` — the Auth.js adapter schema names it, and
 * `display_name` belongs to integration_connection and oidc_provider, which are
 * different tables. Nothing caught it:
 *
 *   the type checker    the query is a template literal; its column names are
 *                       a string as far as TypeScript is concerned, and the
 *                       row interface is an assertion about what comes back,
 *                       not a check against the catalogue.
 *   the drift check     compares the DRIZZLE schema to the catalogue. Both were
 *                       right. The hand-written SQL between them was not.
 *   the build           every route is force-dynamic, so nothing is
 *                       prerendered and no page query runs at build time.
 *   the test suite      the document tests queried `attachment` with their own
 *                       SQL. Testing a query you wrote twice proves the two
 *                       copies agree, not that either is right.
 *
 * The gap was general, not specific: NO test executed a page's queries, so a
 * typo in any of the eleven was invisible until somebody opened it. A page is
 * an async function, so executing one is just awaiting it — every query in its
 * body runs, and a column that does not exist raises 42703 exactly as it did
 * in production. That is the whole mechanism here.
 *
 * AND THEN IT HAPPENED AGAIN, one layer further on. With the query fixed, the
 * pages reached the step AFTER data fetching — React serialising the element
 * tree for the client — and every client page died on
 *
 *     Functions cannot be passed directly to Client Components
 *
 * because five `icon={MapPin}` props handed a Client Component a lucide
 * forwardRef, which is a reference React cannot serialise. That had been latent
 * since the modal rework; the SQL error was simply throwing first, so nothing
 * ever got far enough to serialise anything.
 *
 * So awaiting the page is not enough on its own: it proves the queries run, not
 * that what they produced can cross the boundary. Each page is now walked for
 * props that React would refuse. See tests/support/rsc-boundary.ts.
 *
 * WHAT THIS DOES NOT COVER, said plainly so nobody reads more into a pass: it
 * runs each page's data fetching and walks the element tree it returns. It does
 * not RENDER components, so a mistake inside a component's JSX is not caught
 * here — component logic is tested as extracted functions (src/lib/ui/*), which
 * is where this project puts it. What it does catch is every hand-written SQL
 * string in a page, and every prop a page hands across the client boundary.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { useSessionResolver } from '../../src/lib/auth/session';
import {
  IDS, actor, connectPools, disconnectPools, resetDatabase,
} from './harness';
import { clientComponentNames, describeViolations, findBoundaryViolations } from '../support/rsc-boundary';

/**
 * next/headers reaches into a request scope that does not exist here.
 *
 * An absent tenant cookie is a real case — it is what a first visit after
 * sign-in looks like — so returning nothing is the honest stub rather than a
 * convenience. getServerIdentity() falls back to the first membership, and
 * the account page treats a missing session token as "cannot mark the current
 * row", both of which are the intended behaviour.
 */
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ADMIN = actor(IDS.tenant1, IDS.admin1);

/** Pages take params and searchParams as promises, so this is what Next passes. */
const p = <T,>(value: T) => Promise.resolve(value);

beforeAll(async () => {
  resetDatabase();
  connectPools();

  // The seam session.ts documents for exactly this: "tests substitute a
  // resolver". installSessionResolver() stands down when the slot is claimed.
  useSessionResolver(async () => ({
    id: IDS.admin1,
    email: 'admin@northwind.test',
    name: 'Northwind Admin',
  }));

  // A document, so the client page's attachment query returns a row rather
  // than resolving its column list against nothing. Postgres would raise on a
  // bad column either way — names are resolved at parse time — but a query
  // whose JOIN never matches is one nobody would notice producing nulls.
  await withTenant(ADMIN, async (tx) => {
    const [folder] = await tx<{ id: string }[]>`
      INSERT INTO document_folder (tenant_id, organization_id, name)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'Rendered')
      RETURNING id
    `;
    await tx`
      INSERT INTO attachment (
        tenant_id, organization_id, is_document, folder_id, filename,
        content_type, byte_size, storage_key, content_sha256, uploaded_by
      )
      VALUES (
        ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, true, ${folder!.id},
        'rendered.pdf', 'application/pdf', 64, 'pages/test/a',
        decode(repeat('ab', 32), 'hex'), ${IDS.admin1}::uuid
      )
    `;
  });
});

afterAll(async () => {
  await disconnectPools();
});

/**
 * Every page under (app), with the arguments Next would pass it.
 *
 * Listed explicitly rather than globbed. A glob would silently cover a new page
 * with no arguments and silently SKIP one that needed them, and "the suite
 * grew a page and nobody noticed it was untested" is the same failure this file
 * exists to stop. Adding a page means adding a line here.
 */
const PAGES: { name: string; load: () => Promise<unknown> }[] = [
  {
    name: 'the client detail page',
    load: async () =>
      (await import('../../src/app/(app)/organizations/[organizationId]/page')).default({
        params: p({ organizationId: IDS.orgAcme }),
      }),
  },
  {
    name: 'the client list',
    load: async () =>
      (await import('../../src/app/(app)/organizations/page')).default({ searchParams: p({}) }),
  },
  {
    name: 'the client list, archived',
    load: async () =>
      (await import('../../src/app/(app)/organizations/page')).default({
        searchParams: p({ archived: '1' }),
      }),
  },
  {
    name: 'the asset page',
    load: async () =>
      (await import('../../src/app/(app)/assets/[nodeId]/page')).default({
        params: p({ nodeId: IDS.firewall }),
      }),
  },
  {
    name: 'the dashboard',
    load: async () => (await import('../../src/app/(app)/dashboard/page')).default(),
  },
  {
    name: 'the audit log',
    load: async () =>
      (await import('../../src/app/(app)/audit/page')).default({ searchParams: p({}) }),
  },
  {
    name: 'expirations',
    load: async () =>
      (await import('../../src/app/(app)/expirations/page')).default({ searchParams: p({}) }),
  },
  {
    name: 'expirations, filtered',
    load: async () =>
      (await import('../../src/app/(app)/expirations/page')).default({
        searchParams: p({ severity: 'critical', organizationId: IDS.orgAcme }),
      }),
  },
  {
    name: 'exports',
    load: async () =>
      (await import('../../src/app/(app)/exports/page')).default({ searchParams: p({}) }),
  },
  {
    name: 'people',
    load: async () => (await import('../../src/app/(app)/people/page')).default(),
  },
  {
    name: 'search, with a query',
    load: async () =>
      (await import('../../src/app/(app)/search/page')).default({
        searchParams: p({ q: 'acme' }),
      }),
  },
  {
    name: 'search, empty',
    load: async () =>
      (await import('../../src/app/(app)/search/page')).default({ searchParams: p({}) }),
  },
  {
    name: 'settings',
    load: async () => (await import('../../src/app/(app)/settings/page')).default(),
  },
  {
    name: 'the account page',
    load: async () => (await import('../../src/app/(app)/account/page')).default(),
  },
];

describe('every page runs its queries', () => {
  for (const page of PAGES) {
    it(`${page.name} loads`, async () => {
      const rendered = await page.load();

      // An element, not null and not a thrown 42703. Asserting the shape as
      // well as the absence of a throw, so a page that quietly returns nothing
      // is a failure rather than a pass.
      expect(rendered).toBeTruthy();
      expect(rendered).toHaveProperty('type');
    });
  }
});

describe('every page can cross the client boundary', () => {
  // Read once: it scans every .tsx under src for the directive.
  const clients = clientComponentNames();

  it('knows which components are client components, so the check is not vacuous', () => {
    // A regex that stopped matching would make every assertion below pass
    // against an empty set, which is the failure mode of a source scan.
    expect(clients.size).toBeGreaterThan(20);
    expect(clients).toContain('SectionBrowser');
    expect(clients).toContain('DocumentsCard');
  });

  for (const page of PAGES) {
    it(`${page.name} hands client components only serialisable props`, async () => {
      const violations = findBoundaryViolations(await page.load(), clients);

      expect(
        violations,
        violations.length === 0
          ? ''
          : `React cannot send these to a Client Component:\n${describeViolations(violations)}\n\n` +
            'Render the icon on the server and pass the element (icon={<MapPin />}), ' +
            'or pass a string the client component looks up.',
      ).toEqual([]);
    });
  }
});

/**
 * Find the props of the first element in a tree whose component has this name.
 *
 * A page returns an element tree, and the data it fetched is sitting in the
 * props it handed its components. Reading those is how a value can be asserted
 * without a second copy of the query — which is the trap named at the top of
 * this file, and which the obvious version of the test below fell straight
 * into on the first attempt.
 */
function propsOf(node: unknown, componentName: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, componentName);
      if (found) return found;
    }
    return null;
  }

  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof element.type === 'function' && element.type.name === componentName) {
    return element.props ?? {};
  }
  return element.props ? propsOf(element.props.children, componentName) : null;
}

describe('the query that broke production', () => {
  it('hands the documents card a real uploader name', async () => {
    // The specific regression, asserted on the VALUE the page produced — not
    // on a second copy of the query agreeing with the first, and not merely on
    // the page failing to throw. `display_name` was wrong; so would a bare
    // `u.email` be, and so would dropping the join and passing null.
    const rendered = await (
      await import('../../src/app/(app)/organizations/[organizationId]/page')
    ).default({ params: p({ organizationId: IDS.orgAcme }) });

    const card = propsOf(rendered, 'DocumentsCard');
    expect(card, 'the client page should render a DocumentsCard').toBeTruthy();

    const documents = card!.documents as { filename: string; uploadedBy: string | null }[];
    const rendered_doc = documents.find((d) => d.filename === 'rendered.pdf');

    expect(rendered_doc?.uploadedBy).toBe('Northwind Admin');
  });

  it('...and app_user has no display_name for anything else to reach for', async () => {
    // The root cause was reaching for a column name that is real on
    // integration_connection and oidc_provider and has never existed here. If a
    // migration ever adds one, this fails and somebody re-reads the join.
    const [row] = await withTenant(ADMIN, (tx) => tx<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.app_user'::regclass
          AND attname = 'display_name' AND NOT attisdropped
      ) AS exists
    `);

    expect(row!.exists).toBe(false);
  });
});
