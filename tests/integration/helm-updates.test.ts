/**
 * Installing an update from the Updates page (1210).
 *
 *   1. THE TABLES ARE CLOSED. The application reaches them only through the
 *      functions, and every function insists on tenant:write.
 *   2. THE PASSWORD, EVERY TIME. No password, or the wrong one, queues nothing,
 *      and the database itself refuses a session that has not just stepped up.
 *   3. THE SERVER PICKS THE COMMIT, and only when GitHub says there is a newer
 *      one; nothing is queued while the host updater is not checking in.
 *   4. ONE AT A TIME, and a scheduled one can be cancelled until it starts.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { setLocalPassword } from '../../src/lib/auth/local';
import { withTenant } from '../../src/lib/db/client';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { GET as getUpdates } from '../../src/app/api/tenant/updates/route';
import { POST as requestRoute } from '../../src/app/api/tenant/updates/requests/route';
import { DELETE as cancelRoute } from '../../src/app/api/tenant/updates/requests/[requestId]/route';
import { resetUpdateCache } from '../../src/lib/updates/check';
import { listDeploys } from '../../src/lib/updates/history';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const TECH: SessionUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
const PASSWORDS: Record<string, string> = {
  [IDS.admin1]: 'seven lighthouse keepers',
  [IDS.tech1]: 'nineteen copper doorframes',
};

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
async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}
const updaterSeen = (ago: string) => su((sql) => sql`
  INSERT INTO helm_updater (id, last_seen_at) VALUES (1, now() - ${ago}::interval)
  ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
`);

/** GitHub, as the compare endpoint answers when this build is one behind. */
function githubSaysBehind(): void {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    status: 'ahead', ahead_by: 1, behind_by: 0, html_url: 'https://github.com/compare',
    base_commit: { sha: OLD, html_url: '', commit: { message: 'old', committer: { date: '2026-10-01T00:00:00Z' } } },
    commits: [{ sha: NEW, html_url: '', commit: { message: 'Merge pull request #1 from a/b\n\nNew', committer: { date: '2026-10-02T00:00:00Z' } } }],
    files: [],
  })));
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
  for (const user of [ADMIN, TECH]) {
    await setLocalPassword({
      userId: user.id,
      password: PASSWORDS[user.id]!,
      context: { email: user.email, name: user.email },
      reason: 'test setup',
      connection: 'auth',
    });
  }
  process.env.HELM_BUILD_COMMIT = OLD;
  delete process.env.HELM_UPDATE_CHECK;
}, 120_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.HELM_BUILD_COMMIT;
  await disconnectPools();
});
beforeEach(async () => {
  resetUpdateCache();
  githubSaysBehind();
  await su((sql) => sql`DELETE FROM helm_update`);
  await updaterSeen('10 seconds');
});

describe('the tables', () => {
  it('are closed to the request role, and the status is tenant:write', async () => {
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx`SELECT count(*) FROM helm_update`)).rejects.toThrow(/permission denied/);

    currentUser = TECH;
    expect((await getUpdates(req('GET', '/api/tenant/updates'))).status).toBe(403);

    currentUser = ADMIN;
    const { status, body } = await read(await getUpdates(req('GET', '/api/tenant/updates')));
    expect(status).toBe(200);
    expect(body.status.state).toBe('available');
    expect(body.updater.installed).toBe(true);
    expect(body.requests).toEqual([]);
  });
});

describe('requesting an update', () => {
  it('needs the right password', async () => {
    currentUser = ADMIN;
    expect((await requestRoute(req('POST', '/api/tenant/updates/requests', {}))).status).toBe(400);
    const wrong = await read(await requestRoute(req('POST', '/api/tenant/updates/requests', { password: 'not it' })));
    expect(wrong.status).toBe(401);
    expect(await su((sql) => sql`SELECT count(*)::int AS n FROM helm_update`)).toEqual([{ n: 0 }]);
  });

  it('is refused by the database without a step-up, whatever the route does', async () => {
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx`SELECT * FROM helm.request_helm_update(${NEW})`)).rejects.toThrow(/password again/);
  });

  it('is refused to somebody without tenant:write even with their password', async () => {
    currentUser = TECH;
    const { status } = await read(await requestRoute(req('POST', '/api/tenant/updates/requests', {
      password: PASSWORDS[IDS.tech1],
    })));
    expect(status).toBe(403);
  });

  it('queues the latest commit, now, once', async () => {
    currentUser = ADMIN;
    const { status, body } = await read(await requestRoute(req('POST', '/api/tenant/updates/requests', {
      password: PASSWORDS[IDS.admin1],
    })));
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.request).toMatchObject({ status: 'scheduled', targetCommit: NEW });

    const again = await read(await requestRoute(req('POST', '/api/tenant/updates/requests', {
      password: PASSWORDS[IDS.admin1],
    })));
    expect(again.status).toBe(409);

    const audit = await su((sql) => sql`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'update.requested' AND outcome = 'success'
    `);
    expect(audit[0]!.n).toBeGreaterThan(0);
  });

  it('schedules for later, and can be cancelled before it starts', async () => {
    currentUser = ADMIN;
    const at = new Date(Date.now() + 6 * 3600_000).toISOString();
    const { body } = await read(await requestRoute(req('POST', '/api/tenant/updates/requests', {
      password: PASSWORDS[IDS.admin1], at,
    })));
    expect(new Date(body.request.scheduledFor).toISOString()).toBe(at);

    const cancelled = await read(await cancelRoute(
      req('DELETE', `/api/tenant/updates/requests/${body.request.id}`),
      { params: Promise.resolve({ requestId: body.request.id }) },
    ));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.request.status).toBe('cancelled');

    const twice = await cancelRoute(
      req('DELETE', `/api/tenant/updates/requests/${body.request.id}`),
      { params: Promise.resolve({ requestId: body.request.id }) },
    );
    expect(twice.status).toBe(404);
  });

  it('refuses a time in the past or too far ahead', async () => {
    currentUser = ADMIN;
    for (const at of [new Date(Date.now() - 3600_000), new Date(Date.now() + 40 * 86400_000)]) {
      const { status } = await read(await requestRoute(req('POST', '/api/tenant/updates/requests', {
        password: PASSWORDS[IDS.admin1], at: at.toISOString(),
      })));
      expect(status).toBe(400);
    }
  });

  it('queues nothing while the updater on the host is not checking in', async () => {
    await updaterSeen('10 minutes');
    currentUser = ADMIN;
    const { status, body } = await read(await requestRoute(req('POST', '/api/tenant/updates/requests', {
      password: PASSWORDS[IDS.admin1],
    })));
    expect(status).toBe(409);
    expect(body.error.message).toMatch(/updater is not running/);
  });

  it('queues nothing when there is nothing newer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      status: 'identical', ahead_by: 0, behind_by: 0, html_url: '',
      base_commit: { sha: OLD, html_url: '', commit: { message: 'old' } }, commits: [],
    })));
    currentUser = ADMIN;
    const { status } = await read(await requestRoute(req('POST', '/api/tenant/updates/requests', {
      password: PASSWORDS[IDS.admin1],
    })));
    expect(status).toBe(409);
  });
});

describe('the update history (1220)', () => {
  it('is closed to the app role and needs tenant:write through the function', async () => {
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx`SELECT count(*) FROM helm_deploy`)).rejects.toThrow(/permission denied/);
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.tech1, actorType: 'user' }, (tx) =>
      listDeploys(tx))).rejects.toThrow(/tenant:write/);
  });

  it('names who pushed each version, counts them, and carries the log of a page update', async () => {
    await su(async (sql) => {
      await sql`DELETE FROM helm_deploy`;
      await sql`
        INSERT INTO helm_deploy (deployed_at, commit, source, host_user, title, changes)
        VALUES (now() - interval '2 days', ${OLD}, 'setup', 'nolan', 'By hand',
                ${sql.json([{ pr: 110, title: 'Diagram editor' }])})
      `;
      const [request] = await sql<{ id: string }[]>`
        INSERT INTO helm_update (target_commit, status, requested_by, started_at, finished_at, log, to_commit)
        VALUES (${NEW}, 'succeeded', ${IDS.admin1}, now() - interval '1 hour', now(), 'built fine', ${NEW})
        RETURNING id
      `;
      await sql`
        INSERT INTO helm_deploy (commit, previous_commit, source, update_id, title)
        VALUES (${NEW}, ${OLD}, 'page', ${request!.id}, 'From the page')
      `;
    });

    const deploys = await withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      listDeploys(tx));
    expect(deploys.map((d) => [d.iteration, d.source, d.commit.slice(0, 1)])).toEqual([[2, 'page', 'b'], [1, 'setup', 'a']]);
    expect(deploys[0]).toMatchObject({ requestedBy: expect.any(String), log: 'built fine', previousCommit: OLD });
    expect(deploys[1]).toMatchObject({ hostUser: 'nolan', requestedBy: null, log: null, changes: [{ pr: 110, title: 'Diagram editor' }] });
  });
});
