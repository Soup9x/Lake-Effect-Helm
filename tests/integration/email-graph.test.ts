/**
 * Sending Helm's mail through Microsoft 365 instead of a relay (1010), through
 * the real routes, the real account-email worker and a stub Graph.
 *
 *   SENDS         a setup link goes out through sendMail as the chosen mailbox,
 *                 not kept in Sent Items, with the app's secret only ever in
 *                 the sign-in.
 *   ONLY OURS     a client's Microsoft 365 connection is refused.
 *   SAYS WHY      a mailbox Microsoft does not have, an app without Mail.Send,
 *                 and a removed connection are each recorded on the row.
 *   SWITCHES      saving the relay goes back to it; choosing Microsoft 365
 *                 again leaves the relay's fields where they were.
 *   WHO MAY       tenant:write.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';
import { PUT as putM365 } from '../../src/app/api/integrations/m365/route';
import { DELETE as deleteM365 } from '../../src/app/api/integrations/m365/[connectionId]/route';
import { GET as getEmail, PUT as putRelay } from '../../src/app/api/tenant/smtp/route';
import { PUT as putGraphEmail } from '../../src/app/api/tenant/smtp/microsoft-365/route';
import { POST as invite } from '../../src/app/api/users/route';
import { accountEmailJob } from '../../src/workers/account-email';
import { useGraphTransport } from '../../src/lib/m365/client';
import type { M365Connection } from '../../src/lib/m365/queries';
import type { SmtpSettingView } from '../../src/lib/email/settings';
import type { JobContext, JobLogger } from '../../src/workers/runtime';
import { FakeGraph, type FakeGraphTenant } from '../support/fake-graph';

let h: Harness;
const graph = new FakeGraph();
let currentUser: SessionUser | null = null;
const asAdmin = () => {
  currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
};
const asTech = () => {
  currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
};

const APP_ID = '0b3a1f0e-2222-4c2d-9e7f-123456789abc';
const SECRET = 'northwind-mail-app-secret-never-in-a-message';
const MAILBOX = 'helm@northwind.test';

const northwindTenant = (overrides: Partial<FakeGraphTenant> = {}): FakeGraphTenant => ({
  clientSecret: SECRET,
  displayName: 'Northwind IT',
  users: [],
  skus: [],
  domains: [],
  mailboxes: [MAILBOX],
  ...overrides,
});

const req = (method: string, path: string, payload?: unknown) =>
  new NextRequest(new Request(`https://helm.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function silent(): JobLogger {
  const make = (): JobLogger => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => make() });
  return make();
}
async function deliver(): Promise<Record<string, number>> {
  const ctx: JobContext = { log: silent(), stopping: () => false };
  return (await accountEmailJob().run(ctx)).counts ?? {};
}

/** Connect Microsoft 365 for an organisation, returning its connection id. */
async function connect(organizationId: string, tenant: string): Promise<string> {
  // Saving a connection signs in once to test it.
  if (!graph.tenants.has(tenant)) graph.tenants.set(tenant, northwindTenant());
  asAdmin();
  const response = await putM365(req('PUT', '/api/integrations/m365', {
    organizationId, tenant, clientId: APP_ID, clientSecret: SECRET,
    syncEnabled: false, intervalMinutes: 360, syncUsers: true, syncLicences: true, syncDomains: true,
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  const { connections } = (await response.json()) as { connections: M365Connection[] };
  return connections.find((c) => c.organizationId === organizationId)!.id;
}

async function chooseGraph(connectionId: string, fromAddress = MAILBOX): Promise<Response> {
  asAdmin();
  return putGraphEmail(req('PUT', '/api/tenant/smtp/microsoft-365', { enabled: true, connectionId, fromAddress }));
}

async function setting(): Promise<SmtpSettingView> {
  asAdmin();
  return (await getEmail(req('GET', '/api/tenant/smtp'))).json() as Promise<SmtpSettingView>;
}

async function inviteByLink(email: string): Promise<void> {
  asAdmin();
  const response = await invite(req('POST', '/api/users', {
    email, name: 'New Person', roleKey: 'tier1', orgScopeAll: true, signIn: 'email_link',
  }));
  expect(response.status).toBe(200);
}

async function emailRow(email: string) {
  const [row] = await su((sql) => sql<{ status: string; last_error: string | null }[]>`
    SELECT e.status, e.last_error FROM account_email e JOIN app_user u ON u.id = e.user_id
    WHERE u.email = ${email} ORDER BY e.created_at DESC LIMIT 1`);
  return row;
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  useGraphTransport(graph.transport());
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'email via Microsoft 365 tests' });
  process.env.HELM_PUBLIC_URL = 'https://helm.northwind.test';
}, 180_000);

afterEach(async () => {
  currentUser = null;
  graph.reset();
  await su(async (sql) => {
    await sql`DELETE FROM smtp_setting`;
    await sql`DELETE FROM app_user WHERE email LIKE 'new-%'`;
    await sql`DELETE FROM integration_connection WHERE provider = 'microsoft_graph'`;
  });
});

afterAll(async () => {
  useGraphTransport(null);
  delete process.env.HELM_PUBLIC_URL;
  await disconnectPools();
});

describe('sending through Microsoft 365', () => {
  it('sends a setup link as the chosen mailbox, and keeps the secret in the sign-in', async () => {
    graph.tenants.set('northwind.onmicrosoft.com', northwindTenant());
    const connectionId = await connect(IDS.orgInternal, 'northwind.onmicrosoft.com');
    expect((await chooseGraph(connectionId)).status).toBe(200);
    expect(await setting()).toMatchObject({ enabled: true, delivery: 'microsoft_graph', graphConnectionId: connectionId, fromAddress: MAILBOX });

    await inviteByLink('new-graph@northwind.test');
    expect(await deliver()).toMatchObject({ sent: 1, failed: 0 });

    expect(graph.sent).toHaveLength(1);
    const [mail] = graph.sent;
    expect(mail).toMatchObject({ tenant: 'northwind.onmicrosoft.com', mailbox: MAILBOX, saveToSentItems: false });
    expect(mail!.message.toRecipients).toEqual([{ emailAddress: { address: 'new-graph@northwind.test' } }]);
    expect(mail!.message.subject).toMatch(/Set up your Lake Effect Helm account/);
    expect(mail!.message.body.content).toContain('https://helm.northwind.test/sign-in/reset?token=');
    expect(mail!.message.internetMessageHeaders).toContainEqual({ name: 'X-Helm-Notification', value: '1' });
    expect((await emailRow('new-graph@northwind.test'))!.status).toBe('sent');

    // The secret went to the sign-ins (the connection test, then the send) and
    // nowhere else; the message itself carried only the token.
    const carrying = graph.requests.filter((r) => JSON.stringify(r).includes(SECRET));
    expect(carrying.length).toBeGreaterThan(0);
    expect(new Set(carrying.map((r) => new URL(r.url).host))).toEqual(new Set(['login.microsoftonline.com']));

    // And the setting shows it worked.
    expect(await setting()).toMatchObject({ lastSendOk: true });
  });

  it('refuses a client’s Microsoft 365 connection', async () => {
    const acme = await connect(IDS.orgAcme, 'acmecorp.onmicrosoft.com');
    const response = await chooseGraph(acme);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/your own organisation/);
    expect(await setting()).toMatchObject({ configured: false });
  });
});

describe('says why', () => {
  it('when Microsoft has no mailbox for the sending address', async () => {
    graph.tenants.set('northwind.onmicrosoft.com', northwindTenant({ mailboxes: [] }));
    await chooseGraph(await connect(IDS.orgInternal, 'northwind.onmicrosoft.com'));
    await inviteByLink('new-nobox@northwind.test');
    expect(await deliver()).toMatchObject({ failed: 1 });
    const row = await emailRow('new-nobox@northwind.test');
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.last_error).toMatch(/no mailbox for helm@northwind\.test.*shared mailbox/);
  });

  it('when the app does not have Mail.Send', async () => {
    graph.tenants.set('northwind.onmicrosoft.com', northwindTenant({ forbidden: ['/v1.0/users/'] }));
    await chooseGraph(await connect(IDS.orgInternal, 'northwind.onmicrosoft.com'));
    await inviteByLink('new-noperm@northwind.test');
    await deliver();
    expect((await emailRow('new-noperm@northwind.test'))!.last_error).toMatch(/Mail\.Send/);
  });

  it('when the connection it used has been removed', async () => {
    graph.tenants.set('northwind.onmicrosoft.com', northwindTenant());
    const connectionId = await connect(IDS.orgInternal, 'northwind.onmicrosoft.com');
    await chooseGraph(connectionId);
    asAdmin();
    const removed = await deleteM365(req('DELETE', `/api/integrations/m365/${connectionId}`), {
      params: Promise.resolve({ connectionId }),
    });
    expect(removed.status).toBe(200);
    expect(await setting()).toMatchObject({ delivery: 'microsoft_graph', graphConnectionId: null });

    await inviteByLink('new-gone@northwind.test');
    await deliver();
    expect((await emailRow('new-gone@northwind.test'))!.last_error).toMatch(/connection it used has been removed/);
    expect(graph.sent).toHaveLength(0);
  });
});

describe('switching', () => {
  const RELAY = {
    enabled: true, host: 'smtp.northwind.test', port: 587, security: 'starttls', tlsVerify: true,
    username: null, fromAddress: 'relay@northwind.test', fromName: 'Helm', allowedRecipientDomains: [],
  };

  it('goes back to the relay when the relay is saved, and keeps it for next time', async () => {
    asAdmin();
    expect((await putRelay(req('PUT', '/api/tenant/smtp', RELAY))).status).toBe(200);
    expect(await setting()).toMatchObject({ delivery: 'smtp', host: 'smtp.northwind.test' });

    const connectionId = await connect(IDS.orgInternal, 'northwind.onmicrosoft.com');
    await chooseGraph(connectionId);
    expect(await setting()).toMatchObject({ delivery: 'microsoft_graph', host: 'smtp.northwind.test', fromAddress: MAILBOX });

    asAdmin();
    await putRelay(req('PUT', '/api/tenant/smtp', RELAY));
    expect(await setting()).toMatchObject({ delivery: 'smtp', graphConnectionId: connectionId });
  });
});

describe('who may', () => {
  it('needs tenant:write', async () => {
    const connectionId = await connect(IDS.orgInternal, 'northwind.onmicrosoft.com');
    asTech();
    const response = await putGraphEmail(req('PUT', '/api/tenant/smtp/microsoft-365', {
      enabled: true, connectionId, fromAddress: MAILBOX,
    }));
    expect(response.status).toBe(403);
  });
});
