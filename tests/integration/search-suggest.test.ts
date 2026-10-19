/**
 * The top bar's suggestions, in this client or all of them.
 *
 * WHAT MATTERS:
 *
 *   1. "THIS CLIENT" IS THE PAGE'S CLIENT, worked out from the path — the
 *      organization in /organizations/:id, and the owner of the asset, contact
 *      or document a page is about.
 *   2. IT IS RESOLVED UNDER RLS. A client user on a path naming another
 *      client's record gets no client, not that client's name.
 *   3. "ALL CLIENTS" IS EVERYTHING THE READER CAN SEE, and outside a client
 *      that is all there is.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { connectPools, disconnectPools, IDS, resetDatabase } from './harness';
import { POST as suggest } from '../../src/app/api/search/suggest/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const VIEWER: SessionUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };

interface Out {
  client: { id: string; name: string } | null;
  scoped: boolean;
  groups: { kind: string; hits: { title: string; organizationName: string | null; href: string }[] }[];
}

async function ask(body: Record<string, unknown>, user: SessionUser = ADMIN): Promise<Out> {
  currentUser = user;
  const response = await suggest(new NextRequest(new Request('http://helm.test/api/search/suggest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })), { params: Promise.resolve({}) });
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  return JSON.parse(raw) as Out;
}
const titles = (out: Out) => out.groups.flatMap((g) => g.hits.map((h) => h.title));

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);
afterAll(async () => { await disconnectPools(); });

describe('this client', () => {
  it('is the client of the asset a page is about, and searches only it', async () => {
    const out = await ask({ q: '01', path: `/assets/${IDS.firewall}`, scope: 'client' });
    expect(out.client?.id).toBe(IDS.orgAcme);
    expect(out.scoped).toBe(true);
    expect(titles(out)).toContain('acme-fw-01');
    expect(titles(out)).not.toContain('globex-app-01');
  });

  it('is the organization in the path, on any of its pages', async () => {
    const out = await ask({ q: '01', path: `/organizations/${IDS.orgGlobex}/configurations`, scope: 'client' });
    expect(out.client?.id).toBe(IDS.orgGlobex);
    expect(titles(out)).toEqual(expect.arrayContaining(['globex-app-01']));
    expect(titles(out)).not.toContain('acme-fw-01');
  });

  it('is named before anything is typed, so the toggle can say which client', async () => {
    const out = await ask({ q: '', path: `/organizations/${IDS.orgAcme}` });
    expect(out.client?.id).toBe(IDS.orgAcme);
    expect(out.groups).toEqual([]);
  });

  it('is nobody for a client user on a path naming another client', async () => {
    const out = await ask({ q: '01', path: `/organizations/${IDS.orgGlobex}`, scope: 'client' }, VIEWER);
    expect(out.client).toBeNull();
    expect(out.scoped).toBe(false);
    expect(titles(out)).not.toContain('globex-app-01');
  });
});

describe('all clients', () => {
  it('searches every client the reader can see, and names each hit’s client', async () => {
    const out = await ask({ q: '01', path: `/assets/${IDS.firewall}`, scope: 'all' });
    expect(out.client?.id, 'the client is still named for the toggle').toBe(IDS.orgAcme);
    expect(out.scoped).toBe(false);
    expect(titles(out)).toEqual(expect.arrayContaining(['acme-fw-01', 'globex-app-01']));
    const globex = out.groups.flatMap((g) => g.hits).find((h) => h.title === 'globex-app-01');
    expect(globex?.organizationName).toBeTruthy();
  });

  it('is all there is outside a client', async () => {
    const out = await ask({ q: '01', path: '/dashboard', scope: 'client' });
    expect(out.client).toBeNull();
    expect(titles(out)).toEqual(expect.arrayContaining(['acme-fw-01', 'globex-app-01']));
  });
});
