/**
 * The account page's write surface.
 *
 * Two things are being established here, and the second is the interesting one.
 *
 * First, that the ordinary operations work: rename yourself, see your sessions,
 * end one.
 *
 * Second, that session management did not quietly reopen the boundary it had to
 * reach across. helm_app cannot touch auth_session — §21 of the security model —
 * so all of this goes through SECURITY DEFINER functions that resolve the owner
 * from the session context. The tests that matter are the ones proving a
 * caller cannot name somebody else's session, and that "sign out everywhere
 * else" cannot be pointed at the wrong session.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { sessionRef } from '../../src/lib/auth/session-cookie';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { PATCH as patchAccount } from '../../src/app/api/account/route';
import { POST as postSessions } from '../../src/app/api/account/sessions/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const json = (url: string, payload: unknown, cookie?: string) =>
  new NextRequest(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(payload),
    }),
  );

const patch = (payload: unknown) =>
  new NextRequest(
    new Request('http://helm.test/api/account', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

/** Put a session row in the table, the way a sign-in would. */
async function makeSession(
  userId: string,
  method: 'sso' | 'password' | 'radius',
  token = `tok-${Math.random().toString(36).slice(2)}-${'x'.repeat(24)}`,
): Promise<string> {
  const sql = superuserSql();
  try {
    if (method === 'sso') {
      // The Auth.js adapter's INSERT: three columns, and the default supplies
      // the rest. Worth exercising, because it is the shape that would break if
      // the new columns were ever made NOT NULL without a default.
      await sql`
        INSERT INTO auth_session (session_token, user_id, expires)
        VALUES (${token}, ${userId}::uuid, now() + interval '8 hours')
      `;
    } else {
      await sql`
        SELECT helm.create_local_session(
          ${userId}::uuid, ${token}, 480, ${method}::auth_method,
          '203.0.113.9'::inet, 'Mozilla/5.0 (test)')
      `;
    }
    return token;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function sessionCount(userId: string): Promise<number> {
  const sql = superuserSql();
  try {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auth_session WHERE user_id = ${userId}::uuid
    `;
    return row!.n;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function clearSessions(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM auth_session`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });
}, 120_000);

afterEach(async () => {
  currentUser = null;
  await clearSessions();
});

afterAll(async () => {
  await disconnectPools();
});

describe('PATCH /api/account', () => {
  it('changes your display name', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await patchAccount(patch({ name: 'Jordan Vance' }));
    expect(response.status).toBe(200);
    expect((await body(response)).account).toEqual({ name: 'Jordan Vance' });

    const sql = superuserSql();
    try {
      const [row] = await sql<{ name: string }[]>`
        SELECT name FROM app_user WHERE id = ${IDS.tech1}::uuid
      `;
      expect(row!.name).toBe('Jordan Vance');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('clears the name rather than storing an empty string', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    await patchAccount(patch({ name: null }));

    const sql = superuserSql();
    try {
      const [row] = await sql<{ name: string | null }[]>`
        SELECT name FROM app_user WHERE id = ${IDS.tech1}::uuid
      `;
      expect(row!.name).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('changes only the caller, whatever else is in the body', async () => {
    // The function takes the actor from the session context, so there is no
    // field a caller could add that would redirect it at somebody else.
    const before = await nameOf(IDS.admin1);

    asUser(IDS.tech1, 'tech1@northwind.test');
    await patchAccount(patch({ name: 'Only Mine', userId: IDS.admin1, id: IDS.admin1 }));

    expect(await nameOf(IDS.admin1)).toBe(before);
    expect(await nameOf(IDS.tech1)).toBe('Only Mine');
  });

  it('refuses a name longer than the column allows', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await patchAccount(patch({ name: 'x'.repeat(200) }))).status).toBe(400);
  });
});

describe('listing your own sessions', () => {
  it('shows them with the method each one came through', async () => {
    await makeSession(IDS.tech1, 'password');
    await makeSession(IDS.tech1, 'radius');
    await makeSession(IDS.tech1, 'sso');

    const rows = await mySessions(IDS.tech1);
    expect(rows.map((r) => r.auth_method).sort()).toEqual(['password', 'radius', 'sso']);
  });

  it('records where a local sign-in came from', async () => {
    await makeSession(IDS.tech1, 'radius');
    const [row] = await mySessions(IDS.tech1);
    expect(row!.ip).toBe('203.0.113.9');
    expect(row!.user_agent).toBe('Mozilla/5.0 (test)');
  });

  it('defaults an adapter-written session to sso', async () => {
    // The Auth.js adapter knows nothing about auth_method. If the default ever
    // changed to 'password', every SSO session in the deployment would be
    // mislabelled on this page.
    await makeSession(IDS.tech1, 'sso');
    const [row] = await mySessions(IDS.tech1);
    expect(row!.auth_method).toBe('sso');
  });

  it('never returns the session token itself', async () => {
    const token = await makeSession(IDS.tech1, 'password');
    const rows = await mySessions(IDS.tech1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('agrees with the reference the application computes', async () => {
    // The page lists by the database's hash and revokes by the application's.
    // A divergence would make "this device" unmatchable and turn "sign out
    // everywhere else" into "sign out everywhere".
    const token = await makeSession(IDS.tech1, 'password');
    const [row] = await mySessions(IDS.tech1);
    expect(row!.session_ref).toBe(sessionRef(token));
  });

  it('shows nobody else\'s', async () => {
    await makeSession(IDS.admin1, 'password');
    await makeSession(IDS.tech1, 'password');
    expect(await mySessions(IDS.tech1)).toHaveLength(1);
  });

  it('hides expired ones', async () => {
    const token = await makeSession(IDS.tech1, 'password');
    const sql = superuserSql();
    try {
      await sql`
        UPDATE auth_session SET expires = now() - interval '1 hour'
        WHERE session_token = ${token}
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
    expect(await mySessions(IDS.tech1)).toHaveLength(0);
  });
});

describe('POST /api/account/sessions', () => {
  it('ends one of your own', async () => {
    const doomed = await makeSession(IDS.tech1, 'password');
    await makeSession(IDS.tech1, 'password');

    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await postSessions(
      json('http://helm.test/api/account/sessions', { ref: sessionRef(doomed) }),
    );
    expect(response.status).toBe(200);
    expect(await sessionCount(IDS.tech1)).toBe(1);
  });

  it('CANNOT end somebody else\'s, even knowing the reference', async () => {
    // The whole security property. The ref is not a capability: the function
    // filters on the actor from the session context, so a ref belonging to
    // another user simply matches no row.
    const victim = await makeSession(IDS.admin1, 'password');

    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await postSessions(
      json('http://helm.test/api/account/sessions', { ref: sessionRef(victim) }),
    );

    expect(response.status).toBe(404);
    expect(await sessionCount(IDS.admin1)).toBe(1);
  });

  it('answers a stranger\'s reference exactly as it answers a made-up one', async () => {
    const victim = await makeSession(IDS.admin1, 'password');
    asUser(IDS.tech1, 'tech1@northwind.test');

    const real = await postSessions(
      json('http://helm.test/api/account/sessions', { ref: sessionRef(victim) }),
    );
    const invented = await postSessions(
      json('http://helm.test/api/account/sessions', { ref: 'f'.repeat(32) }),
    );

    // Everything but the request id, which is per-request by design and is the
    // one thing that SHOULD differ.
    const strip = (payload: Record<string, unknown>) => {
      const error = { ...(payload.error as Record<string, unknown>) };
      delete error.requestId;
      return { error };
    };

    expect(real.status).toBe(invented.status);
    expect(strip(await body(real))).toEqual(strip(await body(invented)));
  });

  it('ends every other session and keeps the one making the request', async () => {
    const mine = await makeSession(IDS.tech1, 'password');
    await makeSession(IDS.tech1, 'password');
    await makeSession(IDS.tech1, 'radius');

    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await postSessions(
      json(
        'http://helm.test/api/account/sessions',
        { others: true },
        `authjs.session-token=${mine}`,
      ),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).ended).toBe(2);

    const left = await mySessions(IDS.tech1);
    expect(left).toHaveLength(1);
    expect(left[0]!.session_ref).toBe(sessionRef(mine));
  });

  it('leaves other people alone when signing out everywhere else', async () => {
    const mine = await makeSession(IDS.tech1, 'password');
    await makeSession(IDS.admin1, 'password');

    asUser(IDS.tech1, 'tech1@northwind.test');
    await postSessions(
      json('http://helm.test/api/account/sessions', { others: true }, `authjs.session-token=${mine}`),
    );

    expect(await sessionCount(IDS.admin1)).toBe(1);
  });

  it('refuses to sign out everywhere else without a cookie to keep', async () => {
    // Otherwise a caller holding an API token would end every browser session
    // the owner has, which is not what that button means.
    await makeSession(IDS.tech1, 'password');

    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await postSessions(
      json('http://helm.test/api/account/sessions', { others: true }),
    );

    expect(response.status).toBe(400);
    expect(await sessionCount(IDS.tech1)).toBe(1);
  });

  it('refuses a reference that is not one', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect(
      (await postSessions(json('http://helm.test/api/account/sessions', { ref: 'nope' }))).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------

async function mySessions(userId: string) {
  const sql = superuserSql();
  try {
    // As the app role would see them: the function resolves the actor from the
    // session GUC, so the GUC is what decides whose sessions come back.
    await sql`SELECT set_config('helm.actor_id', ${userId}, false)`;
    return await sql<
      {
        session_ref: string;
        created_at: Date;
        expires: Date;
        auth_method: string;
        ip: string | null;
        user_agent: string | null;
      }[]
    >`SELECT * FROM helm.my_sessions()`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function nameOf(userId: string): Promise<string | null> {
  const sql = superuserSql();
  try {
    const [row] = await sql<{ name: string | null }[]>`
      SELECT name FROM app_user WHERE id = ${userId}::uuid
    `;
    return row!.name;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
