/**
 * Filling in and editing a flexible asset record.
 *
 * WHAT WAS MISSING. Everything about a record except the first write. 0080 gave
 * the model, group C gave the type a screen, and POST /api/flexible-assets/
 * records has existed throughout — but there was no PATCH anywhere, so a record
 * could be created and then never corrected, and the asset page had no
 * `flexible_asset` entry in DETAIL_TABLES, so every record in the product
 * rendered "No type-specific detail recorded" over the whole of its contents.
 *
 * THE TWO DECISIONS THESE TESTS PIN, because neither is self-evident from the
 * code and both are easy to "simplify" back into a bug:
 *
 *   1. An edit validates against the type's CURRENT version, not the record's
 *      pinned one, and a successful edit therefore IS the migration — it moves
 *      type_version_id forward and clears needs_migration. Validating against
 *      the pinned version instead would strand a record on its original schema:
 *      a field added since could never be filled in, because the schema that
 *      would accept it is not the one being checked against.
 *
 *   2. A blank secret box means UNCHANGED. A record's secret values live in
 *      flexible_asset_secret and are never sent to a browser, so the form
 *      cannot prefill them — which makes `required` on a secret field a trap:
 *      every edit would fail unless the technician retyped the password. The
 *      route reads the record's existing secret rows and counts them as
 *      present.
 *
 * AND THE ONE THAT MATTERS MOST: a record's secret value never lands in the
 * jsonb document. The database would refuse it (0080's trigger, hardened in
 * 0240), so the tests here assert the application never gets that far, and the
 * trigger stays the backstop rather than the control.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { fieldsToSchema, searchablePointers, type FieldDef } from '../../src/lib/flexible/fields';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, type Harness,
} from './harness';
import { POST as createType } from '../../src/app/api/flexible-assets/types/route';
import { POST as publishVersion } from '../../src/app/api/flexible-assets/types/[typeId]/versions/route';
import { POST as createRecord } from '../../src/app/api/flexible-assets/records/route';
import { PATCH as patchRecord } from '../../src/app/api/flexible-assets/records/[recordId]/route';

/*
 * The asset page calls cookies() to resolve which tenant the reader is looking
 * at, and there is no request scope in a test. Returning nothing exercises the
 * fallback — the first membership — which is the identity every actor here
 * already has. Same mock as pages.test.ts and client-widgets.test.ts.
 */
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let h: Harness;
let currentUser: SessionUser | null = null;
const admin = actor(IDS.tenant1, IDS.admin1);

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`http://helm.test${url}`, init));
const send = (method: string) => (url: string, payload: unknown) =>
  request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
const post = send('POST');
const patch = send('PATCH');
const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

/** Read a response body once; see flexible-types.test.ts for why this exists. */
async function read(response: Response): Promise<{
  status: number; payload: Record<string, unknown>; raw: string;
}> {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A non-JSON body is its own diagnostic; `raw` carries it.
  }
  return { status: response.status, payload, raw };
}

async function ok(response: Response): Promise<Record<string, unknown>> {
  const { status, payload, raw } = await read(response);
  expect(status, raw).toBe(200);
  return payload;
}

/** The template used almost everywhere here: one required text, one optional
 *  integer, one optional secret. */
const BASE: FieldDef[] = [
  { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
  { key: 'port', label: 'Port', kind: 'integer', required: false },
  { key: 'api_token', label: 'API token', kind: 'secret', required: false },
];

async function createTypeFrom(key: string, fields: FieldDef[]): Promise<string> {
  const { jsonSchema, uiSchema } = fieldsToSchema(fields);
  return (await ok(await createType(post('/api/flexible-assets/types', {
    key,
    name: `Type ${key}`,
    jsonSchema,
    uiSchema,
    searchableFields: searchablePointers(fields, ['hostname']),
  })))).typeId as string;
}

async function publish(typeId: string, fields: FieldDef[]): Promise<number> {
  const { jsonSchema, uiSchema } = fieldsToSchema(fields);
  const payload = await ok(await publishVersion(
    post(`/api/flexible-assets/types/${typeId}/versions`, {
      jsonSchema, uiSchema, searchableFields: searchablePointers(fields, ['hostname']),
    }),
    withParams({ typeId }),
  ));
  return payload.version as number;
}

async function create(typeId: string, data: Record<string, unknown>, name = 'rec'): Promise<string> {
  return (await ok(await createRecord(post('/api/flexible-assets/records', {
    typeId, organizationId: IDS.orgAcme, name, data,
  })))).nodeId as string;
}

const edit = (nodeId: string, data: Record<string, unknown>) =>
  patchRecord(patch(`/api/flexible-assets/records/${nodeId}`, { data }), withParams({ recordId: nodeId }));

interface RecordState {
  data: Record<string, unknown>;
  needs_migration: boolean;
  type_version_id: string;
  version: number;
  updated_at: Date;
}

async function state(nodeId: string): Promise<RecordState> {
  return withTenant(admin, async (tx) => {
    const [row] = await tx<RecordState[]>`
      SELECT r.data, r.needs_migration, r.type_version_id, v.version, n.updated_at
      FROM flexible_asset_record r
      JOIN flexible_asset_type_version v ON v.id = r.type_version_id
      JOIN asset_node n ON n.id = r.id
      WHERE r.id = ${nodeId}::uuid
    `;
    if (!row) throw new Error(`no record ${nodeId}`);
    return row;
  });
}

/**
 * The secret behind one field, and which version it is on.
 *
 * secret.current_version rather than a count over secret_version: helm_app has
 * no SELECT on the ciphertext table at all, by design — every read of it goes
 * through a SECURITY DEFINER function. The counter is maintained by
 * helm.write_secret_version and is the same number a rotation advances.
 */
async function secretOf(nodeId: string, pointer: string): Promise<{ id: string; versions: number }> {
  return withTenant(admin, async (tx) => {
    const [row] = await tx<{ id: string; versions: number }[]>`
      SELECT f.secret_id AS id, s.current_version AS versions
      FROM flexible_asset_secret f
      JOIN secret s ON s.id = f.secret_id
      WHERE f.record_id = ${nodeId}::uuid AND f.field_path = ${pointer}
    `;
    if (!row) throw new Error(`no secret at ${pointer} on ${nodeId}`);
    return row;
  });
}

async function plaintext(secretId: string, version?: number): Promise<string> {
  const revealed = await h.secrets.reveal(
    admin, secretId, { purpose: 'view', ...(version === undefined ? {} : { version }) },
  );
  return revealed.value.use((value) => value);
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

afterEach(() => { currentUser = null; });
afterAll(async () => { await disconnectPools(); });

const asAdmin = () => { currentUser = { id: IDS.admin1, email: 'admin@northwind.test' }; };

/** Every string anywhere in a rendered tree. Cycles are why this is a walk. */
function textIn(node: unknown): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { found.push(value); return; }
    if (typeof value === 'number' || typeof value === 'bigint') {
      found.push(String(value)); return;
    }
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child);
  };
  walk(node);
  return found;
}

/** The props a named component was handed, found anywhere in the tree. */
function propsOf(node: unknown, name: string): Record<string, unknown> | null {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): Record<string, unknown> | null => {
    if (value === null || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    const element = value as { type?: unknown; props?: Record<string, unknown> };
    if (typeof element.type === 'function' && element.type.name === name && element.props) {
      return element.props;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(node);
}

const renderAsset = async (nodeId: string): Promise<unknown> =>
  (await import('../../src/app/(app)/assets/[nodeId]/page')).default({
    params: Promise.resolve({ nodeId }),
  });


describe('editing a record', () => {
  it('changes a field and leaves the stored secret completely alone', async () => {
    asAdmin();
    const typeId = await createTypeFrom('edit_plain', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', port: 443, api_token: 'first-token' });
    const before = await secretOf(nodeId, '/api_token');
    expect(before.versions).toBe(1);

    await ok(await edit(nodeId, { hostname: 'fw-02', port: 443 }));

    const after = await state(nodeId);
    expect(after.data).toEqual({ hostname: 'fw-02', port: 443 });

    // The secret is the same secret, at the same version, with the same value.
    // Any of those three changing would be data loss the UI never asked for.
    const unchanged = await secretOf(nodeId, '/api_token');
    expect(unchanged.id).toBe(before.id);
    expect(unchanged.versions).toBe(1);
    expect(await plaintext(unchanged.id)).toBe('first-token');
  });

  it('does not demand a required secret the record already holds', async () => {
    // Decision 2. Without the heldSecrets hand-off this is a 400, and editing
    // a hostname would require retyping the password every time.
    asAdmin();
    const required: FieldDef[] = [
      { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
      { key: 'api_token', label: 'API token', kind: 'secret', required: true },
    ];
    const typeId = await createTypeFrom('edit_req_secret', required);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'needed' });

    await ok(await edit(nodeId, { hostname: 'fw-renamed' }));
    expect((await state(nodeId)).data).toEqual({ hostname: 'fw-renamed' });
    expect(await plaintext((await secretOf(nodeId, '/api_token')).id)).toBe('needed');
  });

  it('still demands a required secret when the record holds none', async () => {
    // The other half of the same rule: "already held" is doing the work, not a
    // blanket exemption for secret fields.
    asAdmin();
    const optional: FieldDef[] = [
      { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
      { key: 'api_token', label: 'API token', kind: 'secret', required: false },
    ];
    const typeId = await createTypeFrom('edit_missing_secret', optional);
    const nodeId = await create(typeId, { hostname: 'fw-01' });

    // v2 makes it required, and this record never had one.
    await publish(typeId, optional.map((f) =>
      f.key === 'api_token' ? { ...f, required: true } : f));

    const refused = await read(await edit(nodeId, { hostname: 'fw-01' }));
    expect(refused.status).toBe(400);
    const fields = (refused.payload.error as { details?: { fields?: { path: string }[] } })
      .details?.fields ?? [];
    expect(fields.map((f) => f.path)).toContain('/api_token');

    // Supplying it is the migration.
    await ok(await edit(nodeId, { hostname: 'fw-01', api_token: 'now-supplied' }));
    expect(await plaintext((await secretOf(nodeId, '/api_token')).id)).toBe('now-supplied');
  });

  it('rotates a supplied secret rather than overwriting it', async () => {
    asAdmin();
    const typeId = await createTypeFrom('edit_rotate', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'old-token' });
    const { id } = await secretOf(nodeId, '/api_token');

    await ok(await edit(nodeId, { hostname: 'fw-01', api_token: 'new-token' }));

    const after = await secretOf(nodeId, '/api_token');
    expect(after.id).toBe(id);
    expect(after.versions).toBe(2);
    expect(await plaintext(id)).toBe('new-token');
    // The old value stays readable, which is what makes "what was the password
    // during the incident" answerable.
    expect(await plaintext(id, 1)).toBe('old-token');
  });

  it('never puts a secret value in the stored document', async () => {
    asAdmin();
    const typeId = await createTypeFrom('edit_no_inline', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'old' });
    await ok(await edit(nodeId, { hostname: 'fw-01', api_token: 'new' }));

    const after = await state(nodeId);
    expect('api_token' in after.data).toBe(false);
    expect(JSON.stringify(after.data)).not.toContain('new');
  });

  it('replaces the document rather than merging into it', async () => {
    // The form renders every field the current version declares and submits
    // all of them, so an omitted key means "cleared". Merging would make a
    // field impossible to empty.
    asAdmin();
    const typeId = await createTypeFrom('edit_replace', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', port: 443 });

    await ok(await edit(nodeId, { hostname: 'fw-01' }));
    expect((await state(nodeId)).data).toEqual({ hostname: 'fw-01' });
  });

  it('refuses a field the current version does not declare', async () => {
    asAdmin();
    const typeId = await createTypeFrom('edit_extra', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });

    const refused = await read(await edit(nodeId, { hostname: 'fw-01', invented: 'x' }));
    expect(refused.status).toBe(400);
    const fields = (refused.payload.error as { details?: { fields?: { path: string }[] } })
      .details?.fields ?? [];
    expect(fields.map((f) => f.path)).toContain('/invented');
  });

  it('refuses the masked placeholder as a secret value', async () => {
    // No form sends it today. One that prefilled a secret box and echoed what
    // it was given would rotate the credential to a publicly known string and
    // audit it as a deliberate change.
    asAdmin();
    const typeId = await createTypeFrom('edit_placeholder', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'real' });

    const refused = await read(await edit(nodeId, {
      hostname: 'fw-01', api_token: '••••••••••••••••',
    }));
    expect(refused.status).toBe(400);
    expect(await plaintext((await secretOf(nodeId, '/api_token')).id)).toBe('real');
  });

  it('touches the node, so the edit shows up where people look for it', async () => {
    asAdmin();
    const typeId = await createTypeFrom('edit_touch', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });
    const before = await state(nodeId);

    await ok(await edit(nodeId, { hostname: 'fw-02' }));

    const after = await state(nodeId);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('is not found rather than forbidden for a record in another tenant', async () => {
    asAdmin();
    const typeId = await createTypeFrom('edit_other_tenant', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });

    currentUser = { id: IDS.admin2, email: 'admin@rival.test' };
    expect((await read(await edit(nodeId, { hostname: 'hijacked' }))).status).toBe(404);
    expect((await state(nodeId)).data).toEqual({ hostname: 'fw-01' });
  });

  it('refuses an actor without asset:write', async () => {
    asAdmin();
    const typeId = await createTypeFrom('edit_read_only', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });

    currentUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };
    expect((await read(await edit(nodeId, { hostname: 'nope' }))).status).toBe(403);
    expect((await state(nodeId)).data).toEqual({ hostname: 'fw-01' });
  });

  /**
   * A CLIENT ADMINISTRATOR CANNOT EDIT A RECORD AT ALL, and the reason is one
   * layer further down than it first appears.
   *
   * client_admin holds asset:write (0900) — they may rename a device and
   * correct a contact — so the route's permission gate lets them in. What
   * stops them is flexible_asset_type: 0200 applies the NON organisation-scoped
   * policy to it, whose predicate is `tenant_id = ... AND is_tenant_wide()`.
   * A client-side role cannot see a template, so the route's own lookup joins
   * to nothing and answers "no such record", exactly as it does for another
   * tenant's.
   *
   * That is worth pinning rather than discovering later, because it is also
   * what keeps asset:write from becoming secret:write by this path: writing a
   * secret field would rotate a secret, and helm.write_secret_version demands
   * secret:write, which no client role holds. In the stock permission set the
   * two gates are belt and braces — this one answers first.
   */
  it('is not found for a client-side actor, whose role cannot see a template', async () => {
    asAdmin();
    const typeId = await createTypeFrom('edit_client_admin', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'msp-set' });

    currentUser = { id: IDS.acmeAdmin, email: 'admin@acme.test' };
    const refused = await read(await edit(nodeId, { hostname: 'fw-02', api_token: 'client-set' }));
    expect(refused.status).toBe(404);

    // Nothing landed, and the secret is untouched — not merely unrotated.
    const after = await state(nodeId);
    expect(after.data).toEqual({ hostname: 'fw-01' });
    const secret = await secretOf(nodeId, '/api_token');
    expect(secret.versions).toBe(1);
    expect(await plaintext(secret.id)).toBe('msp-set');
  });

  it('does not name the template to a client actor through its secret"s label', async () => {
    /*
     * The companion to the test above, and the reason the asset page joins its
     * new secrets arm through flexible_asset_type.
     *
     * A client administrator CAN see the record's asset_node row — it is in
     * their organisation and not internal-only — and RLS does let them read
     * the `secret` row behind its secret field, because flexible_asset_secret
     * is scoped to the RECORD (0200's child policy) rather than to the
     * template. But the secret's label is "<template> — <field>", so listing
     * it hands them the name of a template their role may not read.
     *
     * RENDERED, NOT QUERIED, and the difference is the whole value of the
     * test. The first version of this ran the join itself and asserted the
     * database answers correctly for each actor — which proved the join works,
     * not that the page uses it. Deleting the join from the page left that
     * version passing. This one asks the page.
     */
    asAdmin();
    const typeId = await createTypeFrom('page_client_label', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'msp-set' }, 'Shared box');
    const label = 'Type page_client_label — api_token';

    // The MSP sees the credential, by that label.
    expect(textIn(await renderAsset(nodeId))).toContain(label);

    currentUser = { id: IDS.acmeAdmin, email: 'admin@acme.test' };
    const asClient = textIn(await renderAsset(nodeId));
    // The page still renders for them — the record is in their organisation...
    expect(asClient, 'the record itself should still be visible to them').toContain('Shared box');
    // ...and says nothing about a template they may not read.
    expect(asClient, 'the secret"s label named the template').not.toContain(label);
    expect(
      asClient.filter((t) => t.includes('page_client_label')),
      'the template"s name appeared somewhere else on the page',
    ).toEqual([]);
  });
});

describe('an edit is the migration', () => {
  /** v1 -> v2 where v2 adds a required field: incompatible, so flagged. */
  const V2: FieldDef[] = [
    ...BASE,
    { key: 'region', label: 'Region', kind: 'text', required: true },
  ];

  it('moves the record onto the current version and clears the flag', async () => {
    asAdmin();
    const typeId = await createTypeFrom('migrate_clear', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', port: 443 });
    expect((await state(nodeId)).version).toBe(1);

    expect(await publish(typeId, V2)).toBe(2);
    const flagged = await state(nodeId);
    expect(flagged.needs_migration).toBe(true);
    expect(flagged.version).toBe(1);

    const payload = await ok(await edit(nodeId, {
      hostname: 'fw-01', port: 443, region: 'eu-west-1',
    }));
    expect(payload.migrated).toBe(true);

    const migrated = await state(nodeId);
    expect(migrated.version).toBe(2);
    expect(migrated.needs_migration).toBe(false);
    expect(migrated.data).toEqual({ hostname: 'fw-01', port: 443, region: 'eu-west-1' });
  });

  it('leaves the flag set when the save fails', async () => {
    // The flag means "this record does not satisfy the current schema". If a
    // refused save cleared it, the one record that genuinely needs attention
    // would be the one that stopped asking for it.
    asAdmin();
    const typeId = await createTypeFrom('migrate_keep', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });
    await publish(typeId, V2);
    expect((await state(nodeId)).needs_migration).toBe(true);

    expect((await read(await edit(nodeId, { hostname: 'fw-01' }))).status).toBe(400);

    const after = await state(nodeId);
    expect(after.needs_migration).toBe(true);
    expect(after.version).toBe(1);
  });

  it('validates against the current version, not the version the record pins', async () => {
    // The clearest statement of decision 1: `region` is accepted only because
    // v2 declares it, while the record still points at v1 when the edit
    // arrives. Validating against the pinned schema would reject it as an
    // undeclared field — and there would be no way to ever fill it in.
    asAdmin();
    const typeId = await createTypeFrom('migrate_against_current', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });
    await publish(typeId, V2);

    expect((await state(nodeId)).version).toBe(1);
    await ok(await edit(nodeId, { hostname: 'fw-01', region: 'us-east-1' }));
    expect((await state(nodeId)).data.region).toBe('us-east-1');
  });

  it('validates the typed value when a field stops being secret', async () => {
    /*
     * A record keeps its stored secret when a later version turns that field
     * back into an ordinary one, because nothing deletes encrypted material on
     * a template edit. So the record's heldSecrets still names /api_token
     * while the schema now wants a plain string there — and reinstating the
     * placeholder for it would validate the sixteen-character stand-in instead
     * of what was typed.
     *
     * Pinned with a bound the stand-in breaks and the real value satisfies, so
     * the two cases cannot be confused: `maxLength: 5` accepts "abc" and
     * refuses the placeholder.
     */
    asAdmin();
    const typeId = await createTypeFrom('edit_secret_to_text', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'was-secret' });
    await publish(typeId, [
      { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
      { key: 'port', label: 'Port', kind: 'integer', required: false },
      { key: 'api_token', label: 'API token', kind: 'text', required: false, maxLength: 5 },
    ]);

    await ok(await edit(nodeId, { hostname: 'fw-01', api_token: 'abc' }));
    const after = await state(nodeId);
    expect(after.data.api_token, 'the typed value should be stored, not the stand-in')
      .toBe('abc');

    // And the bound still applies to what was actually typed.
    expect((await read(await edit(nodeId, { hostname: 'fw-01', api_token: 'far too long' })))
      .status).toBe(400);

    // The old secret is untouched — still stored, still at version 1.
    const secret = await secretOf(nodeId, '/api_token');
    expect(secret.versions).toBe(1);
    expect(await plaintext(secret.id)).toBe('was-secret');
  });

  it('drops a field the new version removed, instead of refusing forever', async () => {
    // additionalProperties: false means a leftover key is fatal, so a record
    // written under v1 cannot be saved under a v2 that dropped a field unless
    // the key goes. The form stops rendering it, so the save stops sending it.
    asAdmin();
    const typeId = await createTypeFrom('migrate_removed', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', port: 443 });
    await publish(typeId, BASE.filter((f) => f.key !== 'port'));

    expect((await read(await edit(nodeId, { hostname: 'fw-01', port: 443 }))).status).toBe(400);
    await ok(await edit(nodeId, { hostname: 'fw-01' }));
    expect((await state(nodeId)).data).toEqual({ hostname: 'fw-01' });
  });
});

describe('creating a record', () => {
  it('enforces a required secret on the way in', async () => {
    // Nothing stands in for a value that does not exist yet, so `required`
    // means required here — the exemption is specifically for an edit.
    asAdmin();
    const typeId = await createTypeFrom('create_req_secret', [
      { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
      { key: 'api_token', label: 'API token', kind: 'secret', required: true },
    ]);

    const refused = await read(await createRecord(post('/api/flexible-assets/records', {
      typeId, organizationId: IDS.orgAcme, name: 'no-token', data: { hostname: 'fw-01' },
    })));
    expect(refused.status).toBe(400);
  });

  it('pins the record to the version it was written under', async () => {
    asAdmin();
    const typeId = await createTypeFrom('create_pins', BASE);
    await publish(typeId, [...BASE, { key: 'zone', label: 'Zone', kind: 'text', required: false }]);

    const nodeId = await create(typeId, { hostname: 'fw-01' });
    // Written under v2 because that is current — the pin is to the CURRENT
    // version at write time, which is what makes an older record's pin
    // meaningful later.
    expect((await state(nodeId)).version).toBe(2);
    expect((await state(nodeId)).needs_migration).toBe(false);
  });
});

/**
 * The record on its asset page.
 *
 * THIS IS THE GAP THAT WIDENED C2 BEYOND THE BUTTON. DETAIL_TABLES in
 * src/app/(app)/assets/[nodeId]/page.tsx mapped eleven node types to their
 * subtype table and had no `flexible_asset` entry at all, so detailFor()
 * returned {} and every record ever created rendered "No type-specific detail
 * recorded" over the whole of its contents. Creating records without this
 * would have been a feature that writes data nobody can read.
 *
 * Asserted against the tree the page returns rather than by rendering
 * components, which is what the rest of this project's page tests do and for
 * the reason given at the top of pages.test.ts: it exercises every query and
 * every prop crossing the client boundary, and component JSX is tested as
 * extracted functions.
 */
describe('the record on its asset page', () => {
  it('shows every field of the template, by the label the author gave it', async () => {
    asAdmin();
    const typeId = await createTypeFrom('page_fields', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', port: 443 }, 'Edge firewall');

    const text = textIn(await renderAsset(nodeId));
    expect(text).toContain('Hostname');
    expect(text).toContain('fw-01');
    expect(text).toContain('Port');
    expect(text).toContain('443');
    // And the template's own name, in place of the enum's "Flexible asset".
    expect(text).toContain('Type page_fields');
    expect(text, 'the generic empty state should not appear')
      .not.toContain('No type-specific detail recorded.');
  });

  it('never puts a secret value on the page, and says where it is instead', async () => {
    asAdmin();
    const typeId = await createTypeFrom('page_secret', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'sup3r-s3cret' });

    const text = textIn(await renderAsset(nodeId));
    expect(text).toContain('API token');
    expect(text.join('\u0000'), 'the plaintext reached the page').not.toContain('sup3r-s3cret');
    expect(text.some((t) => t.includes('Encrypted'))).toBe(true);
  });

  it('distinguishes a secret field with a value from one without', async () => {
    // Both render as "no value here", so without this they read identically —
    // and "the API token is not set" is a materially different fact from "the
    // API token is stored and you may reveal it below".
    asAdmin();
    const typeId = await createTypeFrom('page_secret_absent', BASE);
    const withValue = await create(typeId, { hostname: 'a', api_token: 'x' }, 'has-token');
    const without = await create(typeId, { hostname: 'b' }, 'no-token');

    expect(textIn(await renderAsset(withValue)).some((t) => t.includes('see Credentials'))).toBe(true);
    expect(textIn(await renderAsset(without))).toContain('Not set');
  });

  it('keeps the pinned version"s labels, so a field removed since still has a name', async () => {
    /*
     * The read-pinned half of decision 1: the removed field is in this
     * record's document and v2 does not declare it, so rendering against the
     * current version would show the reader less than the record contains.
     *
     * THE LABEL IS WHAT THIS TURNS ON, and the first version of this test
     * could not tell the two apart. Rendering against the current schema does
     * not lose the field — it falls through to the undescribed-key branch,
     * which labels it humanise(key). For a field keyed `port` that is "Port",
     * which is exactly what the pinned schema's own title would have been, so
     * the test passed under the very substitution it was written to catch.
     *
     * So the field is deliberately keyed `port` and TITLED "TCP port": a label
     * humanise() cannot produce. Now the pinned path and the fallback path say
     * visibly different things.
     */
    asAdmin();
    const labelled: FieldDef[] = [
      { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
      { key: 'port', label: 'TCP port', kind: 'integer', required: false },
    ];
    const typeId = await createTypeFrom('page_pinned', labelled);
    const nodeId = await create(typeId, { hostname: 'fw-01', port: 8443 });
    await publish(typeId, labelled.filter((f) => f.key !== 'port'));

    const text = textIn(await renderAsset(nodeId));
    expect(text, 'the pinned schema"s own title').toContain('TCP port');
    expect(text).toContain('8443');
    expect(text, 'that is humanise(key) — the current schema was used').not.toContain('Port');
  });

  it('offers the edit form the CURRENT version"s fields', async () => {
    // ...and the pinned-version rendering above must not leak into it: a form
    // built from v1 could not be saved, because the save validates against v2.
    asAdmin();
    const typeId = await createTypeFrom('page_edit_current', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });
    await publish(typeId, [...BASE, { key: 'region', label: 'Region', kind: 'text', required: true }]);

    const form = propsOf(await renderAsset(nodeId), 'FlexibleRecordForm');
    expect(form, 'the record edit form should be on the page').toBeTruthy();
    const fields = (form!.type as { fields: FieldDef[] }).fields;
    expect(fields.map((f) => f.key)).toEqual(['hostname', 'port', 'api_token', 'region']);
    // And it is told which secrets are held, which is what makes blank mean
    // "unchanged" rather than "required".
    expect((form!.record as { heldSecrets: string[] }).heldSecrets).toEqual([]);
  });

  it('tells the form which secrets are already stored', async () => {
    asAdmin();
    const typeId = await createTypeFrom('page_held', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'stored' });

    const form = propsOf(await renderAsset(nodeId), 'FlexibleRecordForm');
    expect((form!.record as { heldSecrets: string[] }).heldSecrets).toEqual(['/api_token']);
    // The values it is seeded with are the document, which has no secret in it.
    expect((form!.record as { values: Record<string, unknown> }).values)
      .toEqual({ hostname: 'fw-01' });
  });

  it('says so when a record needs migration', async () => {
    asAdmin();
    const typeId = await createTypeFrom('page_migration', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });
    await publish(typeId, [...BASE, { key: 'region', label: 'Region', kind: 'text', required: true }]);

    const text = textIn(await renderAsset(nodeId));
    expect(text).toContain('Needs migration');
    expect(text.some((t) => t.includes('validates it against the current version'))).toBe(true);
  });

  it('shows a field the schema does not describe, rather than hiding it', async () => {
    /*
     * Cannot happen through the API — additionalProperties: false — so this is
     * the row that arrived by SQL, by import, or from a schema edited outside
     * the field model. A value in the document that the page silently drops is
     * worse than an ugly label: the technician believes they can see the whole
     * record.
     */
    asAdmin();
    const typeId = await createTypeFrom('page_stray', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01' });
    await withTenant(admin, (tx) => tx`
      UPDATE flexible_asset_record
      SET data = data || ${tx.json({ legacy_note: 'from the old system' } as never)}::jsonb
      WHERE id = ${nodeId}::uuid
    `);

    const text = textIn(await renderAsset(nodeId));
    expect(text).toContain('Legacy note');
    expect(text).toContain('from the old system');
  });

  it('still renders a retired template"s records, and stops offering to edit them', async () => {
    /*
     * is_active is how a template is taken out of use, and a record written
     * under one does not stop being documentation. So the page's join to
     * flexible_asset_type is an inner one (the record renders) while the join
     * to the type's CURRENT version carries AND t.is_active (there is nothing
     * to validate a save against, so no form is offered). PATCH agrees and
     * answers 404.
     */
    asAdmin();
    const typeId = await createTypeFrom('page_retired', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', port: 443 }, 'Retired box');
    const { PATCH: patchType } =
      await import('../../src/app/api/flexible-assets/types/[typeId]/route');
    await ok(await patchType(
      patch(`/api/flexible-assets/types/${typeId}`, { isActive: false }),
      withParams({ typeId }),
    ));

    const text = textIn(await renderAsset(nodeId));
    expect(text, 'the record"s own fields should still be readable').toContain('Hostname');
    expect(text).toContain('fw-01');
    expect(propsOf(await renderAsset(nodeId), 'FlexibleRecordForm')).toBeNull();
    expect((await read(await edit(nodeId, { hostname: 'fw-02' }))).status).toBe(404);
  });

  it('hands the client boundary nothing React would refuse', async () => {
    /*
     * The same check pages.test.ts runs on every page, applied here because
     * the fixture has no flexible asset record, so that file's asset-page row
     * walks the credential branch and never reaches this one. The specific
     * trap: `trigger` is a RENDERED element handed to a Client Component,
     * which is fine, where a component reference would not be — see the note
     * on Modal's `icon` prop for the production incident that distinction
     * comes from.
     */
    asAdmin();
    const typeId = await createTypeFrom('page_boundary', BASE);
    const nodeId = await create(typeId, { hostname: 'fw-01', api_token: 'x' });

    const { clientComponentNames, describeViolations, findBoundaryViolations } =
      await import('../support/rsc-boundary');
    const violations = findBoundaryViolations(await renderAsset(nodeId), clientComponentNames());
    expect(
      violations.length,
      violations.length === 0 ? '' : describeViolations(violations),
    ).toBe(0);
  });
});

/**
 * The "+ New" button on a type's own page.
 *
 * THE ORIGINALLY REPORTED BUG, and worth a test of its own because what was
 * wrong with it is invisible to every other kind of check: the element was
 * styled, laid out, permission-gated and rendered, and had no handler. It
 * type-checked, it looked right in a screenshot, and clicking it did nothing.
 * Nothing but "is a form actually attached to this?" catches that.
 */
describe('creating from the type page', () => {
  const renderTypePage = async (typeId: string): Promise<unknown> =>
    (await import('../../src/app/(app)/organizations/[organizationId]/flexible/[typeId]/page'))
      .default({ params: Promise.resolve({ organizationId: IDS.orgAcme, typeId }) });

  it('is a form over the template"s current fields, not an inert button', async () => {
    asAdmin();
    const typeId = await createTypeFrom('page_new_button', BASE);

    const form = propsOf(await renderTypePage(typeId), 'FlexibleRecordForm');
    expect(form, 'the + New button is not attached to anything').toBeTruthy();
    expect((form!.type as { id: string }).id).toBe(typeId);
    expect((form!.type as { fields: FieldDef[] }).fields.map((f) => f.key))
      .toEqual(['hostname', 'port', 'api_token']);
    expect(form!.organizationId).toBe(IDS.orgAcme);
    // Creating, not editing: there is no record to seed it with.
    expect(form!.record).toBeUndefined();
  });

  it('offers the newest published version"s fields', async () => {
    asAdmin();
    const typeId = await createTypeFrom('page_new_v2', BASE);
    await publish(typeId, [...BASE, { key: 'region', label: 'Region', kind: 'text', required: true }]);

    const form = propsOf(await renderTypePage(typeId), 'FlexibleRecordForm');
    expect((form!.type as { fields: FieldDef[] }).fields.map((f) => f.key)).toContain('region');
  });

  it('offers nothing when the template has no published schema', async () => {
    /*
     * current_version_id is ON DELETE SET NULL, so a type whose only version
     * was a deleted draft genuinely has none — and POST would refuse a record
     * against it. A form that cannot be submitted is worse than no button.
     * pages.test.ts renders exactly this shape, which is why the page's join
     * is a LEFT one.
     */
    const typeId = await withTenant(admin, async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        INSERT INTO flexible_asset_type (tenant_id, key, name, created_by)
        VALUES (${IDS.tenant1}::uuid, 'schemaless', 'Schemaless', ${IDS.admin1}::uuid)
        RETURNING id
      `;
      return type!.id;
    });

    asAdmin();
    const rendered = await renderTypePage(typeId);
    expect(propsOf(rendered, 'FlexibleRecordForm')).toBeNull();
    // ...and the page still renders rather than throwing on a null schema.
    expect(textIn(rendered)).toContain('Schemaless');
  });

  it('offers nothing to a reader who may not write', async () => {
    asAdmin();
    const typeId = await createTypeFrom('page_new_read_only', BASE);

    currentUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };
    // A client role cannot see the template at all (0200), so the page is a
    // 404 — notFound() throws, which is the assertion.
    await expect(renderTypePage(typeId)).rejects.toThrow();
  });
});
