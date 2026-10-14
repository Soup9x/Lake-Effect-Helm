/**
 * Authoring a flexible asset type through the API.
 *
 * WHAT WAS MISSING, and why these routes exist. POST /api/flexible-assets/types
 * created a type AND published version 1, and there was nothing else: no way to
 * read one type's schema back, no way to edit its metadata, and no way to
 * publish a second version. Published versions are immutable by trigger — which
 * is the right design — so "edit a type's fields" was not merely awkward, it
 * was unexpressible.
 *
 * The three things asserted here beyond the happy path:
 *
 *   1. SEARCHABLE FIELDS MUST BE JSON POINTERS. 0240's indexing trigger does
 *      `substring(v_path from 2)`, so a bare 'hostname' indexes
 *      data->>'ostname' — stored, silent, useless. Worse, with bare names the
 *      secret-overlap guards compare '/api_token' to 'api_token' and miss each
 *      other, in the route AND in the CHECK constraint, so a secret field could
 *      be stored as searchable. Both routes now refuse the bare form.
 *   2. needs_migration IS WRITTEN AND CLEARED. The column, its partial index
 *      and the "Needs migration" flag on the type page have existed since 0080
 *      with nothing ever setting them.
 *   3. SECRET FIELDS ARE DERIVED FROM THE SCHEMA, never taken from the request,
 *      on the new route as on the old one.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { fieldsToSchema, searchablePointers, type FieldDef } from '../../src/lib/flexible/fields';
import { schemaCompatibility } from '../../src/lib/flexible/compatibility';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, type Harness,
} from './harness';
import { POST as createType } from '../../src/app/api/flexible-assets/types/route';
import {
  GET as readType, PATCH as patchType,
} from '../../src/app/api/flexible-assets/types/[typeId]/route';
import {
  POST as publishVersion,
} from '../../src/app/api/flexible-assets/types/[typeId]/versions/route';

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
/**
 * Read a response body ONCE.
 *
 * A Response body is a stream and can only be consumed once, so
 * `expect(response.status, await response.text()).toBe(200)` destroys the body
 * it was only meant to describe — and the *passing* case destroys it too,
 * because the message argument is evaluated eagerly. Every test in this file
 * failed with "Body is unusable" until this helper existed.
 */
async function read(response: Response): Promise<{
  status: number; payload: Record<string, unknown>; raw: string;
}> {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A non-JSON body is itself the diagnostic; `raw` carries it.
  }
  return { status: response.status, payload, raw };
}

/** Assert 2xx and hand back the payload, with the body in the message on failure. */
async function ok(response: Response): Promise<Record<string, unknown>> {
  const { status, payload, raw } = await read(response);
  expect(status, raw).toBe(200);
  return payload;
}

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await read(response)).payload;
const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

const BASE: FieldDef[] = [
  { key: 'hostname', label: 'Hostname', kind: 'text', required: true },
  { key: 'port', label: 'Port', kind: 'integer', required: false },
  { key: 'api_token', label: 'API token', kind: 'secret', required: false },
];

/** A type with version 1 published from BASE. */
async function createBaseType(key: string): Promise<string> {
  const { jsonSchema, uiSchema } = fieldsToSchema(BASE);
  const response = await createType(post('/api/flexible-assets/types', {
    key,
    name: `Type ${key}`,
    jsonSchema,
    uiSchema,
    searchableFields: searchablePointers(BASE, ['hostname']),
  }));
  return (await ok(response)).typeId as string;
}

/** A record of that type, so needs_migration has something to act on. */
async function createRecord(typeId: string, versionId: string, name: string): Promise<string> {
  return withTenant(admin, async (tx) => {
    const [node] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (
        tenant_id, organization_id, node_type, name, criticality, created_by, updated_by
      ) VALUES (
        ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'flexible_asset', ${name}, 3,
        ${IDS.admin1}::uuid, ${IDS.admin1}::uuid
      ) RETURNING id
    `;
    await tx`
      INSERT INTO flexible_asset_record (id, tenant_id, type_id, type_version_id, data)
      VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, ${typeId}::uuid, ${versionId}::uuid,
              ${tx.json({ hostname: 'fw-01', port: 443 } as never)}::jsonb)
    `;
    return node!.id;
  });
}

async function migrationFlags(typeId: string): Promise<boolean[]> {
  return withTenant(admin, async (tx) => {
    const rows = await tx<{ needs_migration: boolean }[]>`
      SELECT needs_migration FROM flexible_asset_record
      WHERE type_id = ${typeId}::uuid ORDER BY id
    `;
    return rows.map((r) => r.needs_migration);
  });
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

describe('reading one type back', () => {
  it('returns the schema already decoded into the editor"s field model', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('read_me');

    const response = await readType(request(`/api/flexible-assets/types/${typeId}`),
      withParams({ typeId }));
    expect(response.status).toBe(200);
    const payload = await body(response);

    // The round trip the editor depends on: what went in comes back as fields.
    expect(payload.fields).toEqual(BASE);
    expect(payload.currentVersion).toBe(1);
    expect(payload.secretFields).toEqual(['/api_token']);
    expect(payload.searchableFields).toEqual(['/hostname']);
    expect(payload.recordCount).toBe(0);
  });

  it('counts the records, because that changes what publishing means', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('count_me');
    const first = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    await createRecord(typeId, first.currentVersionId as string, 'counted-1');

    const after = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    expect(after.recordCount).toBe(1);
  });

  it('is not found rather than forbidden for a type in another tenant', async () => {
    // RLS makes "not yours" and "not there" the same answer everywhere else.
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('other_tenant');
    currentUser = { id: IDS.admin2, email: 'admin@rival.test' };
    const response = await readType(request(`/api/flexible-assets/types/${typeId}`),
      withParams({ typeId }));
    expect(response.status).toBe(404);
  });
});

describe('editing a type"s metadata', () => {
  it('changes the label, icon and colour without touching the schema', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('patch_me');

    const response = await patchType(
      patch(`/api/flexible-assets/types/${typeId}`, {
        name: 'Renamed', description: 'Now explained', icon: 'Server', colour: '#1188ff',
      }),
      withParams({ typeId }),
    );
    expect(response.status).toBe(200);

    const payload = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    expect(payload.name).toBe('Renamed');
    expect(payload.icon).toBe('Server');
    expect(payload.colour).toBe('#1188ff');
    // The version is untouched: metadata and schema are separate costs.
    expect(payload.currentVersion).toBe(1);
    expect(payload.fields).toEqual(BASE);
  });

  it('refuses a colour the CHECK constraint would refuse', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('bad_colour');
    const response = await patchType(
      patch(`/api/flexible-assets/types/${typeId}`, { colour: 'red' }),
      withParams({ typeId }),
    );
    expect(response.status).toBe(400);
  });

  it('will not rename the key, which an integration may have written down', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('stable_key');
    // `key` is not in the accepted shape at all, so it is ignored rather than
    // applied — and the stored key is unchanged.
    await patchType(patch(`/api/flexible-assets/types/${typeId}`, { key: 'renamed', name: 'ok' }),
      withParams({ typeId }));
    const payload = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    expect(payload.key).toBe('stable_key');
  });

  it('refuses an empty patch rather than reporting a no-op as a change', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('empty_patch');
    const response = await patchType(patch(`/api/flexible-assets/types/${typeId}`, {}),
      withParams({ typeId }));
    expect(response.status).toBe(400);
  });
});

describe('publishing a new version', () => {
  it('supersedes version 1 and leaves it in place', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('versioned');
    const added: FieldDef[] = [...BASE, { key: 'notes', label: 'Notes', kind: 'textarea', required: false }];
    const { jsonSchema, uiSchema } = fieldsToSchema(added);

    const response = await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        jsonSchema, uiSchema,
        searchableFields: searchablePointers(added, ['hostname']),
        changeNote: 'added notes',
      }),
      withParams({ typeId }),
    );
    const payload = await ok(response);
    expect(payload.version).toBe(2);
    expect(payload.supersededVersion).toBe(1);

    // Both versions exist; the old one is not edited or removed, because
    // records still point at it.
    const versions = await withTenant(admin, (tx) => tx<{ version: number; status: string }[]>`
      SELECT version, status::text FROM flexible_asset_type_version
      WHERE type_id = ${typeId}::uuid ORDER BY version
    `);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    const read = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    expect(read.currentVersion).toBe(2);
    expect(read.fields).toEqual(added);
  });

  it('derives secret fields from the schema rather than the request', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('derived_secrets');
    const { jsonSchema, uiSchema } = fieldsToSchema(BASE);

    // A caller nominating no secrets must not be believed: the marker in the
    // schema is what decides, or every password lands in `data` in the clear.
    const payload = await body(await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        jsonSchema, uiSchema, searchableFields: [], secretFields: [],
      }),
      withParams({ typeId }),
    ));
    expect(payload.secretFields).toEqual(['/api_token']);
  });

  it('refuses a bare searchable field name instead of storing a no-op', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('bare_pointer');
    const { jsonSchema, uiSchema } = fieldsToSchema(BASE);
    const response = await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        jsonSchema, uiSchema, searchableFields: ['hostname'],
      }),
      withParams({ typeId }),
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await body(response))).toContain('JSON pointers');
  });

  it('refuses a pointer to a field the schema does not declare', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('ghost_pointer');
    const { jsonSchema, uiSchema } = fieldsToSchema(BASE);
    const response = await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        jsonSchema, uiSchema, searchableFields: ['/typo'],
      }),
      withParams({ typeId }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a secret field as searchable — in pointer form, where it is catchable', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('secret_searchable');
    const { jsonSchema, uiSchema } = fieldsToSchema(BASE);
    const response = await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        jsonSchema, uiSchema, searchableFields: ['/api_token'],
      }),
      withParams({ typeId }),
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await body(response))).toContain('cannot also be searchable');
  });

  it('rejects a schema the guard rejects', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('guarded');
    const response = await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        // No additionalProperties: false — the guard's own requirement.
        jsonSchema: { type: 'object', properties: { a: { type: 'string' } } },
        uiSchema: {},
      }),
      withParams({ typeId }),
    );
    expect(response.status).toBe(400);
  });
});

describe('needs_migration, the column nothing used to set', () => {
  it('stays clear when the change cannot invalidate a record', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('compatible_publish');
    const read = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    await createRecord(typeId, read.currentVersionId as string, 'compatible-1');

    // A new optional field is the commonest edit there is. Flagging every
    // record for it would train people to ignore the flag.
    const added: FieldDef[] = [...BASE, { key: 'notes', label: 'Notes', kind: 'text', required: false }];
    const payload = await body(await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        ...fieldsToSchema(added), searchableFields: [],
      }),
      withParams({ typeId }),
    ));
    expect(payload.compatible).toBe(true);
    expect(payload.recordsFlagged).toBe(0);
    expect(await migrationFlags(typeId)).toEqual([false]);
  });

  it('is set when the change could invalidate a record, with the reason', async () => {
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('incompatible_publish');
    const read = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    await createRecord(typeId, read.currentVersionId as string, 'incompatible-1');
    await createRecord(typeId, read.currentVersionId as string, 'incompatible-2');

    // A newly required field rejects every record written without it.
    const tightened: FieldDef[] = [...BASE, { key: 'owner', label: 'Owner', kind: 'text', required: true }];
    const payload = await body(await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        ...fieldsToSchema(tightened), searchableFields: [],
      }),
      withParams({ typeId }),
    ));
    expect(payload.compatible).toBe(false);
    expect((payload.compatibilityReasons as string[]).join(' ')).toContain('now required');
    expect(payload.recordsFlagged).toBe(2);
    expect(await migrationFlags(typeId)).toEqual([true, true]);
  });

  it('is CLEARED by a later compatible publish', async () => {
    // Republishing to undo a mistake should take the warning off the records it
    // was about, rather than leaving them marked for ever.
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('cleared_publish');
    const read = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    await createRecord(typeId, read.currentVersionId as string, 'cleared-1');

    const tightened: FieldDef[] = [...BASE, { key: 'owner', label: 'Owner', kind: 'text', required: true }];
    await publishVersion(post(`/api/flexible-assets/types/${typeId}/versions`, {
      ...fieldsToSchema(tightened), searchableFields: [],
    }), withParams({ typeId }));
    expect(await migrationFlags(typeId)).toEqual([true]);

    /*
     * The fix is to make `owner` OPTIONAL, not to delete it — and the
     * difference is worth stating, because the obvious version of this test
     * published BASE again and failed.
     *
     * Going back to BASE REMOVES the property, and with
     * additionalProperties: false a record written under v2 carrying an `owner`
     * key is then rejected. The comparison is schema-to-schema: it cannot know
     * that these particular records predate the field. So "revert to the
     * previous schema" is not automatically a compatible publish, and the
     * analysis is right to say so.
     *
     * Relaxing the requirement is the compatible correction, and it is also
     * what somebody who over-tightened a field by mistake actually wants.
     */
    const relaxed: FieldDef[] = [...BASE, { key: 'owner', label: 'Owner', kind: 'text', required: false }];
    const payload = await body(await publishVersion(
      post(`/api/flexible-assets/types/${typeId}/versions`, {
        ...fieldsToSchema(relaxed), searchableFields: [],
      }),
      withParams({ typeId }),
    ));
    expect(payload.compatible, (payload.compatibilityReasons as string[] | undefined)?.join(' | '))
      .toBe(true);
    expect(payload.recordsCleared).toBe(1);
    expect(await migrationFlags(typeId)).toEqual([false]);
  });

  it('does NOT treat reverting to an earlier schema as automatically safe', () => {
    // The corollary of the test above, pinned so nobody "simplifies" the
    // analysis into treating a rollback as a no-op. Removing a property is a
    // rejection for any record that carries it.
    const withOwner = [...BASE, { key: 'owner', label: 'Owner', kind: 'text' as const, required: true }];
    const { jsonSchema: v2 } = fieldsToSchema(withOwner);
    const { jsonSchema: v3 } = fieldsToSchema(BASE);
    const verdict = schemaCompatibility(v2, v3);
    expect(verdict.compatible).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('was removed');
  });

  it('leaves type_version_id alone, so the flag keeps meaning something', async () => {
    /*
     * A record's type_version_id records which schema its data was written
     * against. Moving it to the new version would say "this record is v2" while
     * its data is v1-shaped, which makes needs_migration meaningless — and it
     * would point 0240's indexing trigger at the new version's
     * searchable_fields for a document that does not match them.
     */
    currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
    const typeId = await createBaseType('version_pin');
    const read = await body(await readType(
      request(`/api/flexible-assets/types/${typeId}`), withParams({ typeId })));
    const originalVersionId = read.currentVersionId as string;
    await createRecord(typeId, originalVersionId, 'pinned-1');

    await publishVersion(post(`/api/flexible-assets/types/${typeId}/versions`, {
      ...fieldsToSchema([...BASE, { key: 'notes', label: 'N', kind: 'text', required: false }]),
      searchableFields: [],
    }), withParams({ typeId }));

    const [row] = await withTenant(admin, (tx) => tx<{ type_version_id: string }[]>`
      SELECT type_version_id::text FROM flexible_asset_record
      WHERE type_id = ${typeId}::uuid
    `);
    expect(row!.type_version_id).toBe(originalVersionId);
  });
});
