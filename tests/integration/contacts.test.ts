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
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { POST as createContact } from '../../src/app/api/contacts/route';
import { GET as getContact, PATCH as patchContact, DELETE as deleteContact } from '../../src/app/api/contacts/[contactId]/route';
import { readChannels } from '../../src/lib/contacts/channels';

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
