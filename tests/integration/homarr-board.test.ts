/**
 * Homarr board links (1240).
 *
 *   1. THE TABLE IS CLOSED, and links are tenant:write's to list, make and revoke.
 *   2. THE TOKEN IS SHOWN ONCE: the list carries its prefix, never the token.
 *   3. ONLY THE LISTED HOMARR ADDRESSES may frame the page, and an address is
 *      reduced to its origin or refused.
 *   4. THE PAGE SAYS ONLY WHAT THE LINK ALLOWS: counts-only links name nobody,
 *      and no link shows another tenant's data.
 *   5. EVERY "NO" LOOKS THE SAME: wrong, malformed and revoked tokens all get
 *      the same 404 page.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { GET as listRoute, POST as createRoute } from '../../src/app/api/integrations/homarr/route';
import { DELETE as revokeRoute } from '../../src/app/api/integrations/homarr/[linkId]/route';
import { GET as embedRoute } from '../../src/app/embed/homarr/[token]/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const TECH: SessionUser = { id: IDS.tech1, email: 'tech1@northwind.test' };

const req = (method: string, url: string, payload?: unknown) =>
  new NextRequest(new Request(`https://helm.test${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
async function read(response: Response): Promise<{ status: number; body: Record<string, any> }> {
  const raw = await response.text();
  return { status: response.status, body: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}
const embed = (token: string, query = '') =>
  embedRoute(new NextRequest(`https://helm.test/embed/homarr/${token}${query}`), {
    params: Promise.resolve({ token }),
  });
async function make(payload: Record<string, unknown>): Promise<{ id: string; token: string }> {
  currentUser = ADMIN;
  const { status, body } = await read(await createRoute(req('POST', '/api/integrations/homarr', payload)));
  expect(status, JSON.stringify(body)).toBe(200);
  return { id: body.id, token: body.token };
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
  // Acme's domain is due in five days, so there is something critical to name.
  const sql = superuserSql();
  try {
    await sql`UPDATE domain SET expires_at = current_date + 5 WHERE id = ${IDS.domain}::uuid`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}, 120_000);
afterAll(async () => {
  await disconnectPools();
});

describe('managing links', () => {
  it('keeps the table closed and the routes to tenant:write', async () => {
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx`SELECT count(*) FROM homarr_board_link`)).rejects.toThrow(/permission denied/);

    currentUser = TECH;
    expect((await listRoute(req('GET', '/api/integrations/homarr'))).status).toBe(403);
    expect((await createRoute(req('POST', '/api/integrations/homarr', {
      name: 'x', allowedOrigins: ['http://192.168.3.6:7575'], showDetails: false,
    }))).status).toBe(403);
  });

  it('shows the token once and reduces addresses to origins', async () => {
    const { token } = await make({
      name: 'Office board',
      allowedOrigins: ['http://192.168.3.6:7575/board/home', 'https://homarr.example.com/', 'https://homarr.example.com'],
      showDetails: false,
    });
    expect(token).toMatch(/^helm_hb_[A-Za-z0-9]{8}\.[A-Za-z0-9_-]{43}$/);

    const { body } = await read(await listRoute(req('GET', '/api/integrations/homarr')));
    const link = body.links.find((l: any) => l.name === 'Office board');
    expect(link.allowedOrigins).toEqual(['http://192.168.3.6:7575', 'https://homarr.example.com']);
    expect(link.prefix).toBe(token.split('.')[0]);
    expect(JSON.stringify(body)).not.toContain(token.split('.')[1]);
  });

  it('refuses something that is not a web address', async () => {
    currentUser = ADMIN;
    for (const bad of ['*', 'javascript:alert(1)', "https://a.example.com; script-src 'unsafe-inline'", 'ftp://x.example.com']) {
      const { status } = await read(await createRoute(req('POST', '/api/integrations/homarr', {
        name: 'Bad', allowedOrigins: [bad], showDetails: false,
      })));
      expect(status, bad).toBe(400);
    }
  });
});

describe('the page', () => {
  it('frames only for the listed Homarr addresses and counts without naming', async () => {
    const { token } = await make({ name: 'Counts', allowedOrigins: ['http://192.168.3.6:7575'], showDetails: false });
    const response = await embed(token, '?theme=dark');
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors http://192.168.3.6:7575');
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    const html = await response.text();
    expect(html).toContain('Northwind Managed Services');
    expect(html).not.toContain('acme.test');
    expect(html).not.toContain('Acme Manufacturing');
    expect(html).not.toContain('<script');
  });

  it('names what is expiring when the link allows it, and only this tenant', async () => {
    const { token } = await make({ name: 'Details', allowedOrigins: ['https://homarr.example.com'], showDetails: true });
    const html = await (await embed(token)).text();
    expect(html).toContain('acme.test');
    expect(html).toContain('Acme Manufacturing');
    expect(html).toContain('in 5 days');
    expect(html).not.toContain('Contoso');
    expect(html).not.toContain('Rival IT Partners');
  });

  it('answers wrong, malformed and revoked links the same way', async () => {
    const { id, token } = await make({ name: 'Short-lived', allowedOrigins: ['https://homarr.example.com'], showDetails: false });
    expect((await embed(token)).status).toBe(200);

    currentUser = ADMIN;
    expect((await revokeRoute(req('DELETE', `/api/integrations/homarr/${id}`), {
      params: Promise.resolve({ linkId: id }),
    })).status).toBe(200);

    const wrongSecret = `${token.split('.')[0]}.${'A'.repeat(43)}`;
    const answers = await Promise.all([embed(token), embed(wrongSecret), embed('not-a-token')]
      .map(async (p) => { const r = await p; return { status: r.status, body: await r.text() }; }));
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(a.body).toBe(answers[0]!.body);
    }
  });

  it('counts each use', async () => {
    const { token } = await make({ name: 'Counted', allowedOrigins: ['https://homarr.example.com'], showDetails: false });
    await embed(token);
    await embed(token);
    const { body } = await read(await listRoute(req('GET', '/api/integrations/homarr')));
    const link = body.links.find((l: any) => l.name === 'Counted');
    expect(link.useCount).toBe(2);
    expect(link.lastUsedAt).not.toBeNull();
  });
});
