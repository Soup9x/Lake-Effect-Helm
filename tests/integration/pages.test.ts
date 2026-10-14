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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/** Set in beforeAll: the flexible grid needs a real type id in its path. */
let flexibleTypeId = '';
/** Set in beforeAll: a real run, because the run page takes one in its path. */
let runId = '';

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

    /*
     * A flexible asset type, because fixtures.sql ships none and the flexible
     * grid takes a type id in its path. Made here rather than in fixtures.sql
     * so no existing count or search assertion moves: a shared fixture is read
     * by the whole suite, and "the catalogue has one more row than it did"
     * is a change to every test that counts.
     */
    const [type] = await tx<{ id: string }[]>`
      INSERT INTO flexible_asset_type (tenant_id, key, name, description, created_by)
      VALUES (
        ${IDS.tenant1}::uuid, 'rendered_type', 'Rendered Type',
        'exists so the flexible grid has something to render', ${IDS.admin1}::uuid
      )
      RETURNING id
    `;
    flexibleTypeId = type!.id;

    /*
     * A checklist run, for the same reason: the run page takes one in its path.
     * Made here rather than in fixtures.sql, which ships the PROCEDURE and its
     * published version but no run — a run in the shared fixture would move
     * every count the client page asserts.
     *
     * Steps are copied from the published snapshot exactly as POST /api/sop-runs
     * does it, because a run whose steps came from somewhere else would not
     * exercise what the page actually renders.
     */
    const [version] = await tx<{ id: string }[]>`
      SELECT v.id FROM sop_version v
      JOIN sop s ON s.id = v.sop_id AND s.current_version = v.version
      WHERE v.sop_id = ${IDS.sopOffboard}::uuid
    `;
    const [run] = await tx<{ id: string }[]>`
      INSERT INTO sop_run (
        tenant_id, organization_id, sop_id, sop_version_id, title, status,
        started_at, started_by
      )
      VALUES (
        ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, ${IDS.sopOffboard}::uuid,
        ${version!.id}::uuid, 'Offboard J. Doe', 'in_progress', now(),
        ${IDS.admin1}::uuid
      )
      RETURNING id
    `;
    runId = run!.id;
    /*
     * ASSIGNED, AND ONE STEP ALREADY OVERDUE (0650). The My Tasks page and the
     * run page both have an arm that only renders for a step that is late, and
     * a fixture where nothing is due would run neither — the pages would load
     * green while the branch that formats an overdue date went untested.
     *
     * The due date is derived per step so exactly one is in the past, rather
     * than making the whole run late: "some of this is overdue" is the state
     * the page is for.
     */
    await tx`
      INSERT INTO sop_run_step (
        tenant_id, run_id, position, title, body, kind, status, assigned_to, due_at
      )
      SELECT ${IDS.tenant1}::uuid, ${run!.id}::uuid,
             (step ->> 'position')::int, step ->> 'title', step ->> 'body',
             'manual', 'pending', ${IDS.admin1}::uuid,
             CASE WHEN (step ->> 'position')::int = 1
                  THEN now() - interval '2 days'
                  ELSE now() + interval '3 days' END
      FROM sop_version v,
           jsonb_array_elements(v.snapshot -> 'steps') AS step
      WHERE v.id = ${version!.id}::uuid
    `;
    await tx`
      UPDATE sop_run SET assigned_to = ${IDS.admin1}::uuid, due_at = now() + interval '3 days'
      WHERE id = ${run!.id}::uuid
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
 * exists to stop. Adding a page means adding a line here — and the test below
 * this list enforces that, because for two releases the sentence you are
 * reading was the only thing enforcing it, and it did not.
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
    // The type and status filters run in SQL, so they are a different query
    // from the bare list rather than a different render of the same rows.
    name: 'the client list, filtered by type and status',
    load: async () =>
      (await import('../../src/app/(app)/organizations/page')).default({
        searchParams: p({ type: 'vendor', status: 'active', q: 'acme' }),
      }),
  },
  {
    // An unrecognised type is dropped rather than rejected — a stale link
    // should show the list, not an error — and that branch deserves a row.
    name: 'the client list, with a stale type in the URL',
    load: async () =>
      (await import('../../src/app/(app)/organizations/page')).default({
        searchParams: p({ type: 'partner' }),
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
    /*
     * The same page for a PROCEDURE, which is a different arm of it: `sop` was
     * added to DETAIL_TABLES in F1 and the template card is rendered only for
     * this node type. The firewall row above exercises neither, so without
     * this line the whole authoring surface renders in no test.
     */
    name: 'the asset page, for a procedure',
    load: async () =>
      (await import('../../src/app/(app)/assets/[nodeId]/page')).default({
        params: p({ nodeId: IDS.sopOffboard }),
      }),
  },
  {
    /*
     * A checklist run. Added in F1, which is when anything could create one —
     * sop_run had never been written by any code path, so this page is the
     * first thing that reads it.
     */
    name: 'a checklist run',
    load: async () =>
      (await import('../../src/app/(app)/runs/[runId]/page')).default({
        params: p({ runId }),
      }),
  },
  {
    /*
     * My Tasks, added in F2. Three rows rather than one: the state filter and
     * the who filter each change the SQL, and a stale `state` in a URL takes a
     * fourth path that falls back to the default rather than erroring.
     */
    name: 'my tasks',
    load: async () =>
      (await import('../../src/app/(app)/tasks/page')).default({ searchParams: p({}) }),
  },
  {
    name: 'my tasks, overdue only',
    load: async () =>
      (await import('../../src/app/(app)/tasks/page')).default({
        searchParams: p({ state: 'overdue' }),
      }),
  },
  {
    name: 'my tasks, everything, anyone',
    load: async () =>
      (await import('../../src/app/(app)/tasks/page')).default({
        searchParams: p({ state: 'all', who: 'anyone' }),
      }),
  },
  {
    name: 'my tasks, with a stale filter in the URL',
    load: async () =>
      (await import('../../src/app/(app)/tasks/page')).default({
        searchParams: p({ state: 'yesterday' }),
      }),
  },
  {
    /*
     * The coverage grid, added in G. Three rows: the first page, a page past
     * the end (an empty page is not a broken page), and a nonsense ?page,
     * which falls back to the first rather than erroring.
     */
    name: 'coverage',
    load: async () =>
      (await import('../../src/app/(app)/coverage/page')).default({ searchParams: p({}) }),
  },
  {
    name: 'coverage, past the last page',
    load: async () =>
      (await import('../../src/app/(app)/coverage/page')).default({
        searchParams: p({ page: '99' }),
      }),
  },
  {
    name: 'coverage, with a nonsense page in the URL',
    load: async () =>
      (await import('../../src/app/(app)/coverage/page')).default({
        searchParams: p({ page: 'last' }),
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
    // The type authoring screen. Worth running here specifically because it
    // decodes every stored json_schema into the editor's field model on the
    // server and hands the result to a client component — so a schema shape
    // the decoder mishandles, or a prop React refuses to serialise, shows up
    // as a failure rather than as an empty form somebody notices later.
    name: 'settings, asset types',
    load: async () =>
      (await import('../../src/app/(app)/settings/asset-types/page')).default(),
  },
  {
    name: 'the account page',
    load: async () => (await import('../../src/app/(app)/account/page')).default(),
  },
  {
    name: 'the per-category grid',
    load: async () =>
      (await import('../../src/app/(app)/organizations/[organizationId]/[category]/page')).default({
        params: p({ organizationId: IDS.orgAcme, category: 'passwords' }),
        searchParams: p({}),
      }),
  },
  {
    // The filter and sort state this page reads lives in the URL on purpose, so
    // the populated case is a different code path from the bare one and worth
    // its own line rather than a second argument to the same entry.
    name: 'the per-category grid, filtered and sorted',
    load: async () =>
      (await import('../../src/app/(app)/organizations/[organizationId]/[category]/page')).default({
        params: p({ organizationId: IDS.orgAcme, category: 'configurations' }),
        searchParams: p({ q: 'acme', sort: 'name', dir: 'desc', archived: '1' }),
      }),
  },
  {
    name: 'the flexible-asset grid',
    load: async () =>
      (await import('../../src/app/(app)/organizations/[organizationId]/flexible/[typeId]/page'))
        .default({ params: p({ organizationId: IDS.orgAcme, typeId: flexibleTypeId }) }),
  },
];

/**
 * The list above is EXPLICIT, which only works while it is COMPLETE.
 *
 * It was not. The IT Glue shell added the per-category grid and the
 * flexible-asset grid and added no lines here, so two pages shipped with no
 * query execution and no boundary check — the precise gap this file was written
 * after. The instruction above ("adding a page means adding a line here") was
 * the only thing holding the contract, and an instruction in a comment is not a
 * check.
 *
 * So the glob comes back, for the one job a glob is right for: not LOADING
 * pages — the objection to that stands, since a page needs arguments only a
 * human knows — but PROVING the handwritten list names them all. A new page now
 * fails this test by path until somebody writes its line, which is a sentence
 * telling them what to do rather than a silent pass.
 *
 * Scoped to (app) because that is what this file is about: everything under it
 * resolves an identity and a tenant. src/app/page.tsx and the sign-in pages do
 * not, and sweeping them in would mean inventing an unauthenticated harness to
 * satisfy a count.
 */
const APP_DIR = join(import.meta.dirname, '..', '..', 'src', 'app', '(app)');

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (entry === 'page.tsx') out.push(full);
  }
  return out;
}

describe('the list above names every page', () => {
  it('has a line for each page.tsx under (app)', () => {
    const source = readFileSync(join(import.meta.dirname, 'pages.test.ts'), 'utf8');

    // The specifier as it appears in an import() above: posix separators,
    // relative to this directory, no extension.
    const missing = pageFiles(APP_DIR)
      .map((file) => relative(import.meta.dirname, file).replaceAll('\\', '/').replace(/\.tsx$/, ''))
      .filter((specifier) => !source.includes(`import('${specifier}')`));

    expect(
      missing,
      missing.length === 0
        ? 'every page is listed'
        : `these pages have no line in PAGES, so nothing runs their queries or ` +
          `checks what they hand across the client boundary:\n` +
          missing.map((m) => `  ${m}`).join('\n'),
    ).toEqual([]);
  });
});

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

/**
 * Collect every string in an element tree.
 *
 * The asset page renders its detail fields as inline JSX rather than handing
 * them to a named component, so propsOf cannot reach them. Walking for text is
 * how a detail field can be asserted without re-running the page's own query,
 * which is the trap the top of this file describes.
 */
function textIn(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') {
    found.push(node);
    return found;
  }
  /*
   * A NUMBER IS TEXT ON SCREEN. `{count} overdue` is two children — the number
   * and the word — and dropping the number made "1 overdue" unmatchable
   * however the page rendered it. Collected as its own entry, in traversal
   * order, so joining with '' reproduces what the DOM would show: React puts
   * nothing between adjacent children, which is why assertions below join
   * with '' rather than ' '.
   */
  if (typeof node === 'number') {
    found.push(String(node));
    return found;
  }
  if (Array.isArray(node)) {
    for (const child of node) textIn(child, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const element = node as { props?: Record<string, unknown> };
  if (element.props) for (const value of Object.values(element.props)) textIn(value, found);
  return found;
}

describe('the procedure page', () => {
  it('renders its own columns and its step list', async () => {
    /*
     * Two things that are each invisible to "the page did not throw":
     *
     *   the DETAIL_TABLES entry   without ['sop', 'sop'] the page shows "No
     *                             type-specific detail recorded" over the
     *                             category, summary and review interval, which
     *                             is exactly the bug C2 found for records.
     *   the template card         the only route to steps, publishing and
     *                             starting a run.
     *
     * Both assert on values the page itself produced.
     */
    const rendered = await (
      await import('../../src/app/(app)/assets/[nodeId]/page')
    ).default({ params: p({ nodeId: IDS.sopOffboard }) });

    expect(
      textIn(rendered),
      'the procedure"s own columns are not on its page — is `sop` in DETAIL_TABLES?',
    ).toContain('Lifecycle');

    /*
     * And NOT a raw uuid. `sop` is the only subtype table with person-id
     * columns — owner_user_id and reviewed_by — so this page is the only place
     * the detail list's person-id filter can be seen at all. The fixture sets
     * both for that reason.
     */
    expect(
      textIn(rendered).join(' '),
      'a person-id column reached the detail list as a raw uuid',
    ).not.toContain(IDS.admin1);

    const card = propsOf(rendered, 'ChecklistTemplateCard');
    expect(card, 'the procedure page should render a ChecklistTemplateCard').toBeTruthy();

    const template = card!.template as {
      steps: { title: string }[];
      current: { version: number; steps: number } | null;
      unpublishedChanges: boolean;
    };
    expect(template.steps.map((step) => step.title)).toEqual([
      'Disable the account', 'Forward the mailbox', 'Collect the laptop',
    ]);
    expect(template.current?.version, 'the published version did not reach the card').toBe(1);
    expect(template.current?.steps, 'the card was given the live count, not the snapshot"s').toBe(3);
    expect(
      template.unpublishedChanges,
      'the fixture publishes exactly what its step list says, so nothing is unpublished',
    ).toBe(false);
  });
});

describe('my tasks', () => {
  it('renders an overdue step as overdue, and an on-time one not', async () => {
    /*
     * A PAGES row proves the page loads. It cannot see that the branch which
     * formats a late date ever runs — and that branch is the only reason the
     * page is worth opening before something goes wrong.
     *
     * The fixture's run has step 1 due two days ago and the rest due in three,
     * so one word has to appear exactly once.
     */
    const rendered = await (
      await import('../../src/app/(app)/tasks/page')
    ).default({ searchParams: p({}) });

    const text = textIn(rendered);
    expect(text, 'the page should list the steps assigned to this actor')
      .toContain('Disable the account');

    /*
     * MATCHED EXACTLY, NOT BY SUBSTRING. "Overdue" appears twice on this page
     * and only one of them is data: the filter chip is labelled "Overdue" too.
     * A substring count passes at two whatever the rows say, which is the same
     * label-versus-datum collision that hid a bug in group C2 — so the row's
     * own string is matched whole.
     */
    expect(
      text.filter((piece) => piece === 'Overdue — ').length,
      'exactly one of the three fixture steps is late, so one row says so',
    ).toBe(1);
    expect(text.filter((piece) => piece === 'Overdue').length,
      'the filter chip should be there once, and is what the count above excludes').toBe(1);

    // And the badge that counts them, which reads from the same rows.
    expect(text.join(''), 'the overdue badge should quote the number of late steps')
      .toContain('1 overdue');
  });

  it('says so plainly when the filter matches nothing', async () => {
    /*
     * An empty list is a real state with its own message rather than a blank
     * card. Asking for everything already finished and assigned to anyone
     * matches nothing in the fixture — every step is pending.
     */
    const rendered = await (
      await import('../../src/app/(app)/tasks/page')
    ).default({ searchParams: p({ state: 'overdue', who: 'anyone' }) });

    const text = textIn(rendered).join('');
    expect(text, 'an overdue-only list should still show the late step').toContain('Overdue');
    expect(text).toContain('Disable the account');
    expect(text, 'the on-time steps should be filtered out')
      .not.toContain('Collect the laptop');
  });
});

describe('the coverage grid', () => {
  it('renders a count for a documented kind and a dash for a gap', async () => {
    /*
     * The page's whole value is the empty cells, and a PAGES row cannot see
     * them: it proves the queries run, not that a zero renders differently
     * from a two. The fixture gives Acme two devices and no IP addresses, so
     * both arms are on screen at once.
     */
    const rendered = await (
      await import('../../src/app/(app)/coverage/page')
    ).default({ searchParams: p({}) });

    const text = textIn(rendered).join('');
    expect(text, 'the clients should be listed').toContain('Acme Manufacturing');
    expect(text, 'the column should be named as the sidebar names it')
      .toContain('Domain Tracker');
    expect(text, 'a gap should render as a dash, not a blank or a zero').toContain('—');

    // The badge states its own denominator rather than a bare percentage,
    // which is the honesty the whole group turns on.
    expect(text).toMatch(/\d+\/\d+/);
  });

  it('says so plainly when there is nothing to measure', async () => {
    // Not reachable with the fixture loaded, so asserted on the arm that IS:
    // a page past the end keeps its columns and loses its rows.
    const rendered = await (
      await import('../../src/app/(app)/coverage/page')
    ).default({ searchParams: p({ page: '99' }) });

    const text = textIn(rendered).join('');
    expect(text, 'an empty page should explain itself')
      .toContain('There is nothing to measure against yet.');
    expect(text, 'and must not claim the tenant has no clients')
      .not.toContain('There are no clients to measure yet.');
  });
});

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
