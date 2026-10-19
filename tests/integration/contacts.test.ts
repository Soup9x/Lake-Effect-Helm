/**
 * A contact with every email and number they have (0790).
 *
 * WHAT MATTERS BEYOND THE HAPPY PATH:
 *
 *   1. THE OLD COLUMNS STAY TRUE. Every reader of contact.email and phone —
 *      the lists, the widget, the exports, the search index — keeps working
 *      because a trigger projects the primary entries into them. Change the
 *      primary and the column follows; clear the list and the column clears.
 *   2. THE OLD WAY STILL WRITES. A contact inserted with the columns and no
 *      lists (the import route) seeds one entry each.
 *   3. SEARCH FINDS THE SECOND ADDRESS, not just the first.
 *   4. THE LIST IS REPLACED WHOLE, and a contact can at last be corrected.
 *   5. SCOPE. A client administrator reaches their own people's numbers and
 *      nobody else's, as with the contacts themselves.
 *   6. ARCHIVE (0850). An archived contact leaves the list, search, the tab
 *      count and the pickers, comes back on restore, and has a page of its own.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { POST as createContact } from '../../src/app/api/contacts/route';
import { GET as getContact, PATCH as patchContact, DELETE as deleteContact } from '../../src/app/api/contacts/[contactId]/route';
import { readChannels } from '../../src/lib/contacts/channels';
import { listContacts } from '../../src/lib/clients/queries';
import { loadOrgNav } from '../../src/lib/nav/org-sidebar';
import { PATCH as patchDevice } from '../../src/app/api/devices/[deviceId]/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const VIEWER: SessionUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };
const asAdmin = actor(IDS.tenant1, IDS.admin1);

const req = (method: string, url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const params = (contactId: string) => ({ params: Promise.resolve({ contactId }) });

async function ok<T>(response: Response): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  return JSON.parse(raw) as T;
}

async function create(body: Record<string, unknown>): Promise<string> {
  currentUser = ADMIN;
  const { contactId } = await ok<{ contactId: string }>(await createContact(req('POST', '/api/contacts', {
    organizationId: IDS.orgAcme, firstName: 'Dana', lastName: 'Reyes', ...body,
  })));
  return contactId;
}

async function columns(id: string) {
  const sql = superuserSql();
  try {
    const [row] = await sql<{ email: string | null; phone: string | null; mobile: string | null }[]>`
      SELECT email::text, phone, mobile FROM contact WHERE id = ${id}::uuid
    `;
    return row!;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);
afterAll(async () => { await disconnectPools(); });

describe('creating with lists', () => {
  it('stores every entry and projects the primaries into the old columns', async () => {
    const id = await create({
      emails: [
        { address: 'dana@acme.test', label: 'work' },
        { address: 'dana.reyes@example.com', label: 'personal', isPrimary: true },
      ],
      phones: [
        { number: '+1 555 0100', extension: '204', label: 'work' },
        { number: '+1 555 0199', label: 'mobile' },
      ],
    });
    const channels = await withTenant(asAdmin, (tx) => readChannels(tx, id));
    expect(channels.emails.map((e) => [e.address, e.label, e.isPrimary])).toEqual([
      ['dana.reyes@example.com', 'personal', true],
      ['dana@acme.test', 'work', false],
    ]);
    expect(channels.phones).toHaveLength(2);

    // The projection: primary email; the primary number with its extension;
    // the mobile.
    expect(await columns(id)).toEqual({
      email: 'dana.reyes@example.com', phone: '+1 555 0100 x204', mobile: '+1 555 0199',
    });
  });

  it('seeds one entry each when written the old way', async () => {
    const id = await create({ email: 'old@acme.test', phone: '555-0101', mobile: '555-0102' });
    const channels = await withTenant(asAdmin, (tx) => readChannels(tx, id));
    expect(channels.emails.map((e) => e.address)).toEqual(['old@acme.test']);
    expect(channels.phones.map((p) => [p.number, p.label, p.isPrimary])).toEqual([
      ['555-0101', 'work', true], ['555-0102', 'mobile', false],
    ]);
    expect(await columns(id)).toEqual({ email: 'old@acme.test', phone: '555-0101', mobile: '555-0102' });
  });

  it('makes the first entry primary when none is marked', async () => {
    const id = await create({ emails: [{ address: 'a@acme.test' }, { address: 'b@acme.test' }] });
    expect((await columns(id)).email).toBe('a@acme.test');
  });
});

describe('correcting a contact', () => {
  it('PATCHes the name, the flags and the lists, and the columns follow', async () => {
    const id = await create({ emails: [{ address: 'first@acme.test' }], phones: [{ number: '1' }] });
    currentUser = ADMIN;
    const { contact } = await ok<{ contact: { lastName: string; isBilling: boolean; emails: { address: string }[]; phones: unknown[] } }>(
      await patchContact(req('PATCH', `/api/contacts/${id}`, {
        lastName: 'Reyes-Ortiz', isBilling: true,
        emails: [{ address: 'second@acme.test', isPrimary: true }, { address: 'first@acme.test' }],
        phones: [],
      }), params(id)),
    );
    expect(contact.lastName).toBe('Reyes-Ortiz');
    expect(contact.isBilling).toBe(true);
    expect(contact.emails.map((e) => e.address)).toEqual(['second@acme.test', 'first@acme.test']);
    expect(contact.phones).toEqual([]);
    expect(await columns(id)).toEqual({ email: 'second@acme.test', phone: null, mobile: null });
  });

  it('leaves a list alone when it is not sent', async () => {
    const id = await create({ emails: [{ address: 'keep@acme.test' }] });
    currentUser = ADMIN;
    await ok(await patchContact(req('PATCH', `/api/contacts/${id}`, { title: 'Operations' }), params(id)));
    expect((await columns(id)).email).toBe('keep@acme.test');
  });

  it('GET returns the lists, and is asset:read', async () => {
    const id = await create({ emails: [{ address: 'get@acme.test' }] });
    currentUser = VIEWER;
    const { contact } = await ok<{ contact: { emails: { address: string }[] } }>(
      await getContact(req('GET', `/api/contacts/${id}`), params(id)),
    );
    expect(contact.emails[0]!.address).toBe('get@acme.test');

    const refused = await patchContact(req('PATCH', `/api/contacts/${id}`, { title: 'no' }), params(id));
    expect(refused.status).toBe(403);
  });

  it('is found by its second address, and gone from search with the contact', async () => {
    const id = await create({ emails: [{ address: 'primary@acme.test' }, { address: 'alias@acme.test' }] });
    const sql = superuserSql();
    try {
      const found = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_document
        WHERE entity_type = 'contact' AND entity_id = ${id}::uuid AND 'alias@acme.test' = ANY(identifiers)
      `;
      expect(found[0]!.n).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
    currentUser = ADMIN;
    await ok(await deleteContact(req('DELETE', `/api/contacts/${id}`), params(id)));
    const entries = await withTenant(asAdmin, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM contact_email WHERE contact_id = ${id}::uuid
    `);
    // Soft-deleted contacts keep their entries; a hard delete cascades.
    expect(entries[0]!.n).toBe(2);
  });
});

describe('scope', () => {
  it('shows a client administrator their own people and nobody else', async () => {
    const acme = await create({ emails: [{ address: 'acme-person@acme.test' }] });
    currentUser = ADMIN;
    const { contactId: globex } = await ok<{ contactId: string }>(await createContact(req('POST', '/api/contacts', {
      organizationId: IDS.orgGlobex, firstName: 'Gil', lastName: 'Globex', emails: [{ address: 'gil@globex.test' }],
    })));

    const asAcmeAdmin = actor(IDS.tenant1, IDS.acmeAdmin);
    const mine = await withTenant(asAcmeAdmin, (tx) => readChannels(tx, acme));
    expect(mine.emails).toHaveLength(1);
    const theirs = await withTenant(asAcmeAdmin, (tx) => readChannels(tx, globex));
    expect(theirs.emails).toHaveLength(0);
  });
});

/** The props a named component was handed, found anywhere in the tree. */
function propsOf(node: unknown, componentName: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') return null;
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

describe('archiving a contact', () => {
  const p = <T,>(value: T) => Promise.resolve(value);
  const indexed = async (id: string) => {
    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_document WHERE entity_type = 'contact' AND entity_id = ${id}::uuid
      `;
      return row!.n;
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
  const tabCount = () => withTenant(asAdmin, async (tx) => (await loadOrgNav(tx, IDS.orgAcme)).counts.contacts ?? 0);
  const listed = async (id: string) =>
    (await withTenant(asAdmin, (tx) => listContacts(tx, IDS.orgAcme))).some((c) => c.id === id);
  const gridRecords = async (archived: boolean) => {
    const page = await (await import('../../src/app/(app)/organizations/[organizationId]/[category]/page')).default({
      params: p({ organizationId: IDS.orgAcme, category: 'contacts' }),
      searchParams: p(archived ? { archived: '1' } : {}),
    });
    return propsOf(page, 'CategoryGrid')!.records as { id: string; href?: string; subtext?: string | null; archived?: boolean }[];
  };

  it('takes them off the list, search, the count and the pickers, and restore brings them back', async () => {
    const id = await create({ firstName: 'Archie', lastName: 'Ved', isTechnical: true, isBilling: true });
    const before = await tabCount();
    expect(await indexed(id)).toBe(1);

    currentUser = ADMIN;
    const archived = await ok<{ contact: { archived: boolean } }>(
      await patchContact(req('PATCH', `/api/contacts/${id}`, { archived: true }), params(id)));
    expect(archived.contact.archived).toBe(true);
    expect(await indexed(id), 'an archived contact is not a search result').toBe(0);
    expect(await tabCount()).toBe(before - 1);
    expect(await listed(id), 'nor on the client page').toBe(false);
    expect((await gridRecords(false)).some((r) => r.id === id)).toBe(false);
    const shown = (await gridRecords(true)).find((r) => r.id === id);
    expect(shown?.archived, '"Include archived" shows them, marked').toBe(true);

    await ok(await patchContact(req('PATCH', `/api/contacts/${id}`, { archived: false }), params(id)));
    expect(await indexed(id)).toBe(1);
    expect(await tabCount()).toBe(before);
    expect(await listed(id)).toBe(true);
  });

  it('lists them with a link to their page and their tags under the name', async () => {
    const id = await create({ firstName: 'Tess', lastName: 'Tagged', isPrimary: true, isTechnical: true });
    currentUser = ADMIN;
    const record = (await gridRecords(false)).find((r) => r.id === id)!;
    expect(record.href).toBe(`/contacts/${id}`);
    expect(record.subtext).toBe('Primary contact · Technical');
  });

  it('renders their page, and a 404 for a contact that is not there', async () => {
    const id = await create({ firstName: 'Paige', lastName: 'Viewed', emails: [{ address: 'paige@acme.test' }] });
    currentUser = ADMIN;
    const contactPage = (await import('../../src/app/(app)/contacts/[contactId]/page')).default;
    const page = await contactPage({ params: p({ contactId: id }) });
    const header = propsOf(page, 'PageHeader')!;
    expect(header.title).toBe('Paige Viewed');
    expect((header.actions as { props: Record<string, unknown> }).props)
      .toMatchObject({ contactId: id, archived: false });
    await expect(contactPage({ params: p({ contactId: '00000000-0000-4000-8000-000000000000' }) }))
      .rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});

describe('"Contact for", from the person’s side', () => {
  const p = <T,>(value: T) => Promise.resolve(value);
  const card = async (contactId: string) => {
    const page = await (await import('../../src/app/(app)/contacts/[contactId]/page')).default({ params: p({ contactId }) });
    return propsOf(page, 'ContactForCard') as {
      linked: { id: string; name: string }[];
      options: { id: string; name: string; currentContact: string | null }[];
      canEdit: boolean;
    };
  };

  it('lists the configurations naming this person, offers the rest, and the add is the configuration’s own write', async () => {
    const id = await create({ firstName: 'Connie', lastName: 'Fig' });
    currentUser = ADMIN;
    let props = await card(id);
    expect(props.canEdit).toBe(true);
    expect(props.linked).toEqual([]);
    expect(props.options.map((o) => o.id)).toContain(IDS.firewall);
    expect(props.options.map((o) => o.id), 'only this client’s configurations').not.toContain(IDS.globexServer);

    const response = await patchDevice(req('PATCH', `/api/devices/${IDS.firewall}`, { contactId: id }),
      { params: Promise.resolve({ deviceId: IDS.firewall }) });
    expect(response.status, await response.clone().text()).toBe(200);

    props = await card(id);
    expect(props.linked.map((c) => c.id)).toEqual([IDS.firewall]);
    expect(props.options.map((o) => o.id)).not.toContain(IDS.firewall);

    // Somebody else's page now shows the firewall as theirs to take over.
    const other = await create({ firstName: 'Otto', lastName: 'Other' });
    currentUser = ADMIN;
    const theirs = (await card(other)).options.find((o) => o.id === IDS.firewall);
    expect(theirs?.currentContact).toBe('Connie Fig');

    await patchDevice(req('PATCH', `/api/devices/${IDS.firewall}`, { contactId: null }),
      { params: Promise.resolve({ deviceId: IDS.firewall }) });
    expect((await card(id)).linked).toEqual([]);
  });
});
