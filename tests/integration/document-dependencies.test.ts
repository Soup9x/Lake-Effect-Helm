/**
 * A written document's dependencies (1130).
 *
 * WHAT MATTERS BEYOND THE HAPPY PATH:
 *
 *   1. SAME CLIENT ONLY: a document cannot depend on another client's asset,
 *      and the refusal is the database's, not only the route's.
 *   2. ONE LINK PER TARGET, and a document cannot depend on itself.
 *   3. BOTH ENDS READ IT: the document lists what it depends on, and the
 *      asset or document on the other end lists the documents that depend on it.
 *   4. SCOPE: a link from an internal-only document is not there for a
 *      client user looking at the asset.
 *   5. DELETION CASCADES: a deleted target takes its links with it.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase } from './harness';
import { POST as createRoute } from '../../src/app/api/document-pages/route';
import {
  DELETE as unlinkRoute, GET as listRoute, POST as linkRoute,
} from '../../src/app/api/document-pages/[pageId]/dependencies/route';
import { listDependents, type Dependency, type Dependent } from '../../src/lib/documents/links';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const VIEWER: SessionUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };
const asAdmin = actor(IDS.tenant1, IDS.admin1);
const asAcmeAdmin = actor(IDS.tenant1, IDS.acmeAdmin);

const req = (method: string, url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

async function ok<T>(response: Response): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  return JSON.parse(raw) as T;
}

async function newPage(title: string, isInternalOnly = false): Promise<string> {
  currentUser = ADMIN;
  const { page } = await ok<{ page: { id: string } }>(await createRoute(req('POST', '/api/document-pages', {
    organizationId: IDS.orgAcme, title, isInternalOnly,
  })));
  return page.id;
}

const link = (pageId: string, payload: Record<string, unknown>) =>
  linkRoute(req('POST', `/api/document-pages/${pageId}/dependencies`, payload), params(pageId));
const list = async (pageId: string) =>
  ok<{ dependencies: Dependency[]; dependents: Dependent[] }>(
    await listRoute(req('GET', `/api/document-pages/${pageId}/dependencies`), params(pageId)));

beforeAll(async () => {
  resetDatabase();
  connectPools();
  const harness = buildHarness();
  resetServices();
  setKekProvider(harness.kek);
  useSessionResolver(async () => currentUser);
}, 120_000);
afterAll(async () => { resetServices(); await disconnectPools(); });

describe('a document depending on things', () => {
  it('links to an asset and another document, and both ends see it', async () => {
    const runbook = await newPage('Firewall runbook');
    const prereq = await newPage('Read this first');

    await ok(await link(runbook, { kind: 'asset', targetId: IDS.firewall, note: 'the one it covers' }));
    await ok(await link(runbook, { kind: 'document', targetId: prereq }));

    const { dependencies } = await list(runbook);
    expect(dependencies.map((d) => [d.kind, d.title])).toEqual([
      ['asset', 'acme-fw-01'],
      ['document', 'Read this first'],
    ]);
    expect(dependencies[0]!.label).toBe('Device');
    expect(dependencies[0]!.href).toBe(`/assets/${IDS.firewall}`);
    expect(dependencies[0]!.note).toBe('the one it covers');

    const { dependents } = await list(prereq);
    expect(dependents.map((d) => d.title)).toEqual(['Firewall runbook']);

    const onAsset = await withTenant(asAdmin, (tx) => listDependents(tx, 'asset', IDS.firewall));
    expect(onAsset.map((d) => d.title)).toContain('Firewall runbook');
  });

  it('refuses another client, a duplicate and itself', async () => {
    const page = await newPage('Picky');
    expect((await link(page, { kind: 'asset', targetId: IDS.globexServer })).status).toBe(400);

    await ok(await link(page, { kind: 'asset', targetId: IDS.firewall }));
    expect((await link(page, { kind: 'asset', targetId: IDS.firewall })).status).toBe(409);
    expect((await link(page, { kind: 'document', targetId: page })).status).toBe(400);

    // The database says so too, not only the route.
    await expect(withTenant(asAdmin, (tx) => tx`
      INSERT INTO document_page_link (tenant_id, organization_id, page_id, target_node_id)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, ${page}::uuid, ${IDS.globexServer}::uuid)
    `)).rejects.toThrow(/same client/);
  });

  it('is asset:write to link', async () => {
    const page = await newPage('Viewer cannot');
    currentUser = VIEWER;
    expect((await link(page, { kind: 'asset', targetId: IDS.firewall })).status).toBe(403);
  });

  it('hides an internal document from a client user looking at the asset', async () => {
    const secret = await newPage('Internal escalation notes', true);
    await ok(await link(secret, { kind: 'asset', targetId: IDS.firewall }));

    const forAdmin = await withTenant(asAdmin, (tx) => listDependents(tx, 'asset', IDS.firewall));
    expect(forAdmin.map((d) => d.title)).toContain('Internal escalation notes');
    const forClient = await withTenant(asAcmeAdmin, (tx) => listDependents(tx, 'asset', IDS.firewall));
    expect(forClient.map((d) => d.title)).not.toContain('Internal escalation notes');
  });

  it('removes a link, and a deleted target takes its links with it', async () => {
    const page = await newPage('Short-lived');
    const target = await newPage('Going away');
    const { id } = await ok<{ id: string }>(await link(page, { kind: 'document', targetId: target }));
    await ok(await link(page, { kind: 'asset', targetId: IDS.network }));

    currentUser = ADMIN;
    await ok(await unlinkRoute(req('DELETE', `/api/document-pages/${page}/dependencies`, { id }), params(page)));
    expect((await list(page)).dependencies.map((d) => d.kind)).toEqual(['asset']);

    await ok(await link(page, { kind: 'document', targetId: target }));
    await withTenant(asAdmin, (tx) => tx`DELETE FROM document_page WHERE id = ${target}::uuid`);
    expect((await list(page)).dependencies.map((d) => d.kind)).toEqual(['asset']);
  });
});
