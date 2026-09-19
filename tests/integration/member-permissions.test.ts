/**
 * Per-user permission overrides, driven through the route.
 *
 * membership_permission has always been honoured by set_session_context() and
 * has never been writable from the product: no route, no interface, and — until
 * 0480 — no UPDATE or DELETE policy either, so a grant made with a psql prompt
 * could not be taken back through the request path at all. Both statements
 * affected zero rows and reported success.
 *
 * Three things are being tested here, and only the first is the feature:
 *
 *   the write path exists and works, including revocation;
 *   the two authority rules hold through it (0480), so the new UI cannot be
 *   used to hand somebody an authority the granter lacks or to put an MSP-only
 *   permission in a client's hands;
 *   a grant actually changes what the next session resolves, which is the only
 *   thing that makes any of it real.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { resetServices } from '../../src/lib/services';
import {
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
  buildHarness,
} from './harness';

import {
  GET as listPermissions,
  POST as grantPermission,
  DELETE as revokePermission,
} from '../../src/app/api/users/[userId]/permissions/route';

let h: Harness;
let currentUser: SessionUser | null = null;

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`http://helm.test${url}`, init));

const post = (userId: string, body: unknown) =>
  grantPermission(
    request(`/api/users/${userId}/permissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) } as never,
  );

const list = (userId: string) =>
  listPermissions(request(`/api/users/${userId}/permissions`), {
    params: Promise.resolve({ userId }),
  } as never);

const remove = (userId: string, permission: string) =>
  revokePermission(
    request(`/api/users/${userId}/permissions?permission=${permission}`, { method: 'DELETE' }),
    { params: Promise.resolve({ userId }) } as never,
  );

const json = async (r: Response) => (await r.json()) as Record<string, any>;

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The audit chain is append-only and hash-linked, so a test cannot clear it
 * between cases the way it clears membership_permission. Mark the head first
 * and read only what comes after.
 */
const auditHead = () =>
  su(async (sql) => {
    const [r] = await sql<{ head: string | null }[]>`
      SELECT max(chain_seq)::text AS head FROM audit_log
    `;
    return r?.head ?? '0';
  });

const auditSince = (head: string) =>
  su((sql) => sql<{ action: string; reason: string | null; metadata: any }[]>`
    SELECT action, reason, metadata FROM audit_log
    WHERE chain_seq > ${head}::bigint AND action LIKE 'membership.permission_%'
    ORDER BY chain_seq
  `);

/** What the DATABASE resolves for somebody, which is the only answer that counts. */
const permissionsOf = (userId: string) =>
  withTenant(
    { tenantId: IDS.tenant1, actorId: userId, actorType: 'user' },
    async (_tx, session) => session.permissions,
  );

const asSuperAdmin = () => {
  currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
};

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  useSessionResolver(async () => currentUser);
  void h;
}, 120_000);

beforeEach(async () => {
  asSuperAdmin();
  await su(async (sql) => {
    await sql`DELETE FROM membership_permission`;
    await sql`UPDATE membership SET role_key = 'tier1' WHERE user_id = ${IDS.tech1}::uuid`;
  });
});

afterAll(async () => {
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('granting and revoking', () => {
  it('grants a permission, and the next session actually has it', async () => {
    // tier1 does not hold asset:delete. The assertion that matters is not that
    // a row appeared, it is that set_session_context() resolves differently
    // afterwards.
    expect(await permissionsOf(IDS.tech1)).not.toContain('asset:delete');

    const response = await post(IDS.tech1, {
      permissionKey: 'asset:delete',
      granted: true,
      reason: 'covering the on-call rotation while Dana is on leave',
    });

    expect(response.status).toBe(200);
    expect((await json(response)).granted).toBe(true);
    expect(await permissionsOf(IDS.tech1)).toContain('asset:delete');
  });

  it('writes a DENY, which subtracts a permission the role grants', async () => {
    // The other direction, and a different intention from removing the row:
    // a deny takes away something the role would otherwise give.
    expect(await permissionsOf(IDS.tech1)).toContain('asset:write');

    await post(IDS.tech1, {
      permissionKey: 'asset:write',
      granted: false,
      reason: 'read-only while their account is under review',
    });

    expect(await permissionsOf(IDS.tech1)).not.toContain('asset:write');
  });

  it('REVOKES a grant — the half that silently did nothing before 0480', async () => {
    await post(IDS.tech1, {
      permissionKey: 'asset:delete',
      granted: true,
      reason: 'covering the on-call rotation while Dana is on leave',
    });
    expect(await permissionsOf(IDS.tech1)).toContain('asset:delete');

    const response = await remove(IDS.tech1, 'asset:delete');

    expect(response.status).toBe(200);
    expect(await permissionsOf(IDS.tech1)).not.toContain('asset:delete');
    // ...and the row is gone, not merely flipped. Removing an override returns
    // the person to whatever their role says; a deny would pin it off.
    const remaining = await su(async (sql) => {
      const [r] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM membership_permission`;
      return Number(r!.n);
    });
    expect(remaining).toBe(0);
  });

  it('revoking something that was never granted is a 404, not a silent success', async () => {
    const response = await remove(IDS.tech1, 'asset:delete');
    expect(response.status).toBe(404);
  });

  it('re-granting corrects the reason and expiry instead of conflicting', async () => {
    await post(IDS.tech1, {
      permissionKey: 'asset:delete',
      granted: true,
      reason: 'first reason, which turns out to be wrong',
    });
    const response = await post(IDS.tech1, {
      permissionKey: 'asset:delete',
      granted: true,
      reason: 'INC-8821 — needs the vault until the migration completes',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    expect(response.status).toBe(200);
    const [row] = await su(async (sql) =>
      sql<{ reason: string; expires_at: Date | null }[]>`
        SELECT reason, expires_at FROM membership_permission
      `,
    );
    expect(row!.reason).toMatch(/INC-8821/);
    expect(row!.expires_at).not.toBeNull();
  });

  it('honours the expiry, so temporary access really is temporary', async () => {
    await post(IDS.tech1, {
      permissionKey: 'asset:delete',
      granted: true,
      reason: 'for the migration weekend only, expires Monday',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(await permissionsOf(IDS.tech1)).toContain('asset:delete');

    // Age the row rather than waiting a day. It edits what the route wrote.
    await su((sql) => sql`
      UPDATE membership_permission SET expires_at = now() - interval '1 minute'
    `);
    expect(await permissionsOf(IDS.tech1)).not.toContain('asset:delete');
  });

  it('requires a reason of real length — an override outlives the memory of it', async () => {
    const response = await post(IDS.tech1, {
      permissionKey: 'asset:delete',
      granted: true,
      reason: 'because',
    });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('the authority rules hold through the route', () => {
  it('refuses to grant a permission the CALLER does not hold', async () => {
    // A super admin holds everything, so the rule needs a caller who does not.
    // tier3 holds user:write and rank 80 and does NOT hold tenant:write — and
    // before 0480 it could write itself exactly that grant here and be rank-100
    // in effect on its next request.
    await su(async (sql) => {
      await sql`UPDATE membership SET role_key = 'tier3' WHERE user_id = ${IDS.tech1}::uuid`;
      // Give tier3 the route's own gate so the test reaches the trigger rather
      // than stopping at the permission check. The escalation it then attempts
      // is key:rotate, which tier3 still does not hold.
      await sql`
        INSERT INTO role_permission (role_key, permission_key)
        VALUES ('tier3', 'tenant:write') ON CONFLICT DO NOTHING
      `;
    });
    currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };

    try {
      const response = await post(IDS.admin1, {
        permissionKey: 'key:rotate',
        granted: true,
        reason: 'granting myself the key rotation permission, which I lack',
      });

      expect(response.status).toBe(403);
      expect((await json(response)).error.message).toMatch(/do not hold it yourself/i);
    } finally {
      await su((sql) => sql`
        DELETE FROM role_permission WHERE role_key = 'tier3' AND permission_key = 'tenant:write'
      `);
    }
  });

  it('refuses an MSP-only permission for a client-side role', async () => {
    // secret:export is msp_only. 0020 blocks it on role_permission; until 0480
    // nothing blocked it here, and a client_admin holding it is the precondition
    // for pulling another client's credentials out in a bundle.
    const response = await post(IDS.acmeAdmin, {
      permissionKey: 'secret:export',
      granted: true,
      reason: 'the customer asked for their own credential handover',
    });

    expect(response.status).toBe(403);
    expect((await json(response)).error.message).toMatch(/MSP-only/i);
    expect(await permissionsOf(IDS.acmeAdmin)).not.toContain('secret:export');
  });

  it('allows a non-MSP-only permission for the same client-side role', async () => {
    // So the rule above is about which permission, not about refusing every
    // grant to a customer. secret:reveal is not msp_only: an MSP may genuinely
    // decide a co-managed client can see their own credentials.
    const response = await post(IDS.acmeAdmin, {
      permissionKey: 'secret:reveal',
      granted: true,
      reason: 'co-managed arrangement agreed in the MSA, reviewed annually',
    });

    expect(response.status).toBe(200);
    expect(await permissionsOf(IDS.acmeAdmin)).toContain('secret:reveal');
  });

  it('refuses a caller holding only user:write', async () => {
    // The gate was raised from user:write to tenant:write in 0480: writing an
    // override changes what the role catalogue means for one person, which is a
    // change to the authority model rather than to somebody's job.
    await su((sql) => sql`
      UPDATE membership SET role_key = 'tier3' WHERE user_id = ${IDS.tech1}::uuid
    `);
    currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };

    const response = await post(IDS.acmeAdmin, {
      permissionKey: 'secret:reveal',
      granted: true,
      reason: 'a tier3 attempting to widen somebody else’s access',
    });

    expect(response.status).toBe(403);
    expect(await permissionsOf(IDS.acmeAdmin)).not.toContain('secret:reveal');
  });

  it('refuses to edit your OWN permissions', async () => {
    const response = await post(IDS.admin1, {
      permissionKey: 'secret:reveal',
      granted: false,
      reason: 'an administrator denying themselves something by accident',
    });

    expect(response.status).toBe(403);
    expect((await json(response)).error.message).toMatch(/your own permissions/i);
  });

  it('refuses a cross-tenant subject', async () => {
    // admin2 belongs to tenant 2. The membership lookup runs under tenant 1's
    // RLS, so there is nothing to find — and the answer must not reveal that
    // the account exists elsewhere.
    const response = await post(IDS.admin2, {
      permissionKey: 'secret:reveal',
      granted: true,
      reason: 'reaching into the other MSP’s staff list',
    });
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('what the interface is told', () => {
  it('lists the overrides with who granted them and why', async () => {
    await post(IDS.tech1, {
      permissionKey: 'asset:delete',
      granted: true,
      reason: 'covering the on-call rotation while Dana is on leave',
    });

    const body = await json(await list(IDS.tech1));

    expect(body.overrides).toHaveLength(1);
    expect(body.overrides[0]).toMatchObject({
      permissionKey: 'asset:delete',
      granted: true,
      grantedBy: 'admin@northwind.test',
    });
    expect(body.overrides[0].reason).toMatch(/on-call rotation/);
    expect(body.canManage).toBe(true);
  });

  it('offers a client-side role no MSP-only permission to pick from', async () => {
    // The picker is derived from the same two rules the database enforces, so
    // the interface does not present a choice that comes back as an error.
    const body = await json(await list(IDS.acmeAdmin));

    expect(body.isClientSide).toBe(true);
    const keys = (body.grantable as { key: string }[]).map((p) => p.key);
    expect(keys).not.toContain('secret:export');
    expect(keys).not.toContain('tenant:write');
    expect(keys).toContain('secret:reveal');
  });

  it('offers an MSP-side role only what the CALLER holds', async () => {
    const body = await json(await list(IDS.tech1));
    expect(body.isClientSide).toBe(false);
    const keys = (body.grantable as { key: string }[]).map((p) => p.key);
    // A super admin holds everything, so this is the full catalogue.
    expect(keys).toContain('secret:export');
    expect(keys).toContain('key:rotate');
  });

  it('tells a reader without tenant:write that they may not manage', async () => {
    await su((sql) => sql`
      UPDATE membership SET role_key = 'tier3' WHERE user_id = ${IDS.tech1}::uuid
    `);
    currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };

    const body = await json(await list(IDS.acmeAdmin));
    expect(body.canManage).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the audit trail', () => {
  it('records a grant and a revoke as distinct, reasoned events', async () => {
    const head = await auditHead();
    await post(IDS.tech1, {
      permissionKey: 'asset:delete',
      granted: true,
      reason: 'covering the on-call rotation while Dana is on leave',
    });
    await remove(IDS.tech1, 'asset:delete');

    const rows = await auditSince(head);

    expect(rows.map((r) => r.action)).toEqual([
      'membership.permission_granted',
      'membership.permission_revoked',
    ]);
    expect(rows[0]!.reason).toMatch(/on-call rotation/);
    expect(rows[0]!.metadata.permission_key).toBe('asset:delete');
    expect(rows[0]!.metadata.subject_user_id).toBe(IDS.tech1);
    expect(rows[1]!.metadata.was_granted).toBe(true);
  });

  it('records a deny under its own action, not as a grant', async () => {
    const head = await auditHead();
    await post(IDS.tech1, {
      permissionKey: 'asset:write',
      granted: false,
      reason: 'read-only while their account is under review',
    });

    const rows = await auditSince(head);
    expect(rows.map((r) => r.action)).toEqual(['membership.permission_denied']);
  });
});
