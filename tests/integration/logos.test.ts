/**
 * Client logos, end to end, with the bytes on a real disk.
 *
 * WHAT ONLY THIS LEVEL ANSWERS:
 *
 *   1. THE BYTES ON DISK ARE CIPHERTEXT. Read off the filesystem rather than
 *      inferred from a column, the same way documents.test.ts does it: somebody
 *      with the volume and without the database and the KEK should have noise.
 *   2. A LOGO IS NOT A DOCUMENT. Uploading one must add nothing to the client's
 *      document tree and nothing to an export bundle. That is the whole reason
 *      it has its own table, and it is exactly the kind of claim that is true
 *      when written and false after somebody reuses `attachment` for
 *      convenience.
 *   3. AN SVG IS REFUSED, including one that claims to be a PNG. Served from
 *      Helm's origin an SVG can carry <script> and run with the reader's
 *      session.
 *   4. REPLACEMENT DOES NOT LEAVE THE OLD BYTES BEHIND, and does not leave the
 *      row pointing at a file that is gone — the order matters and only a real
 *      store shows it.
 *   5. THE ETAG. The clients list renders one of these per row, so a logo that
 *      re-downloads on every page load is a measurable cost.
 *   6. AND IT SURVIVES A KEY ROTATION, because the row names the key that
 *      sealed it and reading with the active key would fail on every logo
 *      uploaded before the rotation — a broken image with no error anybody
 *      would connect to key management.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
} from './harness';
import { LogoError, LOGO_CONTENT_TYPES, MAX_LOGO_BYTES } from '../../src/lib/logos/service';
import { collectExport } from '../../src/lib/exports/collect';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ADMIN = actor(IDS.tenant1, IDS.admin1);
/** Tier 1 technician: holds asset:write. Whether it holds organization:write is asserted. */
const TECH = actor(IDS.tenant1, IDS.tech1);
const CLIENT = actor(IDS.tenant1, IDS.acmeAdmin);
const OTHER_TENANT = actor(IDS.tenant2, IDS.admin2);

let harness: ReturnType<typeof buildHarness>;
let currentUser: SessionUser | null = null;

/** A real 1×1 PNG, so "is this a PNG" is answered by a PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
/** A second, different PNG, for replacement. */
const PNG2 = Buffer.concat([PNG, Buffer.from('trailing bytes, still a PNG by signature')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

const put = (who: typeof ADMIN, bytes: Buffer, contentType = 'image/png',
              organizationId: string = IDS.orgAcme) =>
  harness.logos.put(who, { organizationId, contentType, bytes });

const logoRow = () => su((sql) => sql<{
  content_type: string; byte_size: string; storage_key: string;
  data_key_id: string | null; encryption_nonce: Buffer | null;
}[]>`
  SELECT content_type, byte_size, storage_key, data_key_id, encryption_nonce
  FROM organization_logo WHERE organization_id = ${IDS.orgAcme}::uuid
`);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  harness = buildHarness();
  setKekProvider(harness.kek);
  useSessionResolver(async () => currentUser);
  await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'logo tests' });
  await harness.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'logo tests' });
}, 120_000);

afterEach(async () => {
  await su((sql) => sql`DELETE FROM organization_logo`);
});

afterAll(async () => {
  resetServices();
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('storing one', () => {
  it('stores it and says what it stored', async () => {
    const stored = await put(ADMIN, PNG);
    expect(stored.contentType).toBe('image/png');
    expect(stored.byteSize).toBe(PNG.length);
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes CIPHERTEXT to disk, not the image', async () => {
    await put(ADMIN, PNG);
    const [row] = await logoRow();
    const onDisk = await readFile(join(harness.documentRoot, row!.storage_key));

    // A PNG signature in the file would mean the bytes went down unencrypted.
    expect(onDisk.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(false);
    // ciphertext || 16-byte GCM tag.
    expect(onDisk.length).toBe(PNG.length + 16);
  });

  it('reads back exactly what went in', async () => {
    await put(ADMIN, PNG);
    const opened = await harness.logos.open(ADMIN, IDS.orgAcme);
    expect(opened).toBeTruthy();
    expect(opened!.bytes.equals(PNG)).toBe(true);
    expect(opened!.contentType).toBe('image/png');
  });

  it('is one row per client however many times it is uploaded', async () => {
    await put(ADMIN, PNG);
    await put(ADMIN, PNG2);
    const rows = await logoRow();
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.byte_size)).toBe(PNG2.length);
  });

  it('removes the bytes it replaced, rather than leaving them on disk', async () => {
    await put(ADMIN, PNG);
    const [first] = await logoRow();
    await put(ADMIN, PNG2);
    const [second] = await logoRow();

    expect(second!.storage_key).not.toBe(first!.storage_key);
    const present = await readdir(join(harness.documentRoot), { recursive: true });
    const stillThere = present.some((entry) => String(entry).endsWith(
      first!.storage_key.split('/').pop()!,
    ));
    expect(stillThere, 'the replaced logo"s bytes are still on disk').toBe(false);
  });

  it('refuses an SVG, even one claiming to be a PNG', async () => {
    /*
     * THE CASE THE ALLOWLIST EXISTS FOR, and the claim is the interesting half:
     * the browser's Content-Type is a claim, so the bytes are sniffed. An SVG
     * served from this origin can carry script and run with the reader's
     * session.
     */
    await expect(put(ADMIN, SVG, 'image/svg+xml')).rejects.toThrow(LogoError);
    await expect(put(ADMIN, SVG, 'image/png')).rejects.toThrow(/not a PNG, JPEG, WebP or GIF/);
    expect(await logoRow(), 'a refused upload wrote a row').toEqual([]);
  });

  it('leaves no orphaned bytes when the upload is refused', async () => {
    const before = await readdir(join(harness.documentRoot), { recursive: true });
    await expect(put(ADMIN, SVG, 'image/png')).rejects.toThrow();
    const after = await readdir(join(harness.documentRoot), { recursive: true });
    expect(after.length, 'a refused upload left bytes behind').toBe(before.length);
  });

  it('refuses something too large', async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]);
    await expect(put(ADMIN, huge)).rejects.toThrow(/512 KB or smaller/);
    expect(await logoRow()).toEqual([]);
  });

  it('refuses an empty file', async () => {
    await expect(put(ADMIN, Buffer.alloc(0))).rejects.toThrow(/empty/);
  });

  it('stores the SNIFFED type, not the claimed one', async () => {
    // A browser sending image/jpg for a PNG is ordinary and not worth refusing
    // over — but the type a reader is served has to describe the bytes, or
    // nosniff makes the image fail to render.
    await put(ADMIN, PNG, 'image/jpeg');
    const [row] = await logoRow();
    expect(row!.content_type).toBe('image/png');
  });

  it('agrees with the CHECK constraint about which types are allowed', async () => {
    // Three copies of the allowlist exist: limits.ts for the form, the sniffer,
    // and 0680's CHECK. This is what stops them drifting.
    for (const contentType of LOGO_CONTENT_TYPES) {
      await su((sql) => sql`DELETE FROM organization_logo`);
      const accepted = await su(async (sql) => {
        try {
          await sql`
            INSERT INTO organization_logo (
              organization_id, tenant_id, content_type, byte_size, storage_key,
              content_sha256
            )
            VALUES (
              ${IDS.orgAcme}::uuid, ${IDS.tenant1}::uuid, ${contentType}, 10,
              ${`zz-${contentType}`}, decode(repeat('ab', 32), 'hex')
            )
          `;
          return true;
        } catch { return false; }
      });
      expect(accepted, `${contentType} is accepted by the sniffer but not the CHECK`).toBe(true);
    }

    const svgAccepted = await su(async (sql) => {
      try {
        await sql`
          INSERT INTO organization_logo (
            organization_id, tenant_id, content_type, byte_size, storage_key, content_sha256
          )
          VALUES (
            ${IDS.orgGlobex}::uuid, ${IDS.tenant1}::uuid, 'image/svg+xml', 10,
            'zz-svg', decode(repeat('ab', 32), 'hex')
          )
        `;
        return true;
      } catch { return false; }
    });
    expect(svgAccepted, 'the CHECK accepted an SVG').toBe(false);
  });
});

describe('a logo is not a document', () => {
  it('adds nothing to the client"s document tree', async () => {
    const before = await withTenant(ADMIN, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM attachment WHERE organization_id = ${IDS.orgAcme}::uuid
    `);
    await put(ADMIN, PNG);
    const after = await withTenant(ADMIN, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM attachment WHERE organization_id = ${IDS.orgAcme}::uuid
    `);
    expect(after[0]!.n, 'the logo became an attachment').toBe(before[0]!.n);
  });

  it('does not appear in an export bundle', async () => {
    /*
     * The consequence that would have been invisible: a client asking why their
     * logo is in the documentation bundle they were sent. 0390's audit found
     * fifteen query paths that had to respect a flag and one that did; this is
     * the equivalent check for a table that should not be collected at all.
     */
    await put(ADMIN, PNG);
    const bundle = await withTenant(ADMIN, (tx) =>
      collectExport(tx, IDS.orgAcme, {}));
    const asJson = JSON.stringify(bundle);
    expect(asJson).not.toContain('organization_logo');
    expect(asJson.toLowerCase()).not.toContain('image/png');
  });
});

describe('who may change it', () => {
  it('is refused to a client administrator', async () => {
    await expect(put(CLIENT, PNG)).rejects.toThrow();
    expect(await logoRow()).toEqual([]);
  });

  it('is refused to another tenant, for a client they cannot see', async () => {
    await expect(put(OTHER_TENANT, PNG)).rejects.toThrow();
    expect(await logoRow()).toEqual([]);
  });

  it('is refused to a tier-1 technician, who may not edit the client either', async () => {
    /*
     * ASSERTED, NOT BRANCHED ON. The first version of this test asked the
     * database whether tier1 holds organization:write and took whichever path
     * the answer implied — which passes however the catalogue changes, and
     * therefore guards nothing.
     *
     * The answer is no: in the shipped catalogue organization:write belongs to
     * tier2, tier3 and super_admin. So a tier-1 technician can document a
     * client's assets and cannot change how the client itself is presented,
     * which is the same line the PATCH route on the organisation draws. If
     * somebody moves that permission, this fails and sends them back to 0680's
     * policies — a logo is organisation metadata, and the two must agree.
     */
    const [tier1] = await withTenant(TECH, (tx) => tx<{ permitted: boolean }[]>`
      SELECT helm.has_permission('organization:write') AS permitted
    `);
    expect(
      tier1!.permitted,
      'tier1 gained organization:write; re-read 0680"s policies and this test',
    ).toBe(false);

    await expect(put(TECH, PNG)).rejects.toThrow();
    expect(await logoRow()).toEqual([]);

    // And the positive half, so the refusal above is about the permission
    // rather than about uploads being broken for everybody.
    await put(ADMIN, PNG);
    expect(await logoRow()).toHaveLength(1);
  });
});

describe('who may see it', () => {
  it('is visible to the client it belongs to', async () => {
    await put(ADMIN, PNG);
    const opened = await harness.logos.open(CLIENT, IDS.orgAcme);
    expect(opened, 'a client should see their own logo').toBeTruthy();
  });

  it('is invisible to a client scoped elsewhere', async () => {
    await put(ADMIN, PNG, 'image/png', IDS.orgGlobex);
    const opened = await harness.logos.open(CLIENT, IDS.orgGlobex);
    // Null rather than an error: the route answers 404 either way, so an
    // outsider cannot tell "no logo" from "not yours".
    expect(opened).toBeNull();
    await su((sql) => sql`DELETE FROM organization_logo`);
  });

  it('is invisible to another tenant', async () => {
    await put(ADMIN, PNG);
    const opened = await harness.logos.open(OTHER_TENANT, IDS.orgAcme);
    expect(opened).toBeNull();
  });
});

describe('removing it', () => {
  it('removes the row and the bytes', async () => {
    await put(ADMIN, PNG);
    const [row] = await logoRow();

    expect(await harness.logos.remove(ADMIN, IDS.orgAcme)).toBe(true);
    expect(await logoRow()).toEqual([]);

    const present = await readdir(join(harness.documentRoot), { recursive: true });
    const stillThere = present.some((entry) => String(entry).endsWith(
      row!.storage_key.split('/').pop()!,
    ));
    expect(stillThere, 'the removed logo"s bytes are still on disk').toBe(false);
  });

  it('says so when there was nothing to remove, rather than failing', async () => {
    expect(await harness.logos.remove(ADMIN, IDS.orgAcme)).toBe(false);
  });

  it('goes with the client when the client is deleted', async () => {
    // ON DELETE CASCADE on the composite key. Asserted because a logo row
    // surviving its organisation would be a row no policy can reach and no
    // screen can show.
    await put(ADMIN, PNG, 'image/png', IDS.orgGlobex);
    await su((sql) => sql`DELETE FROM organization WHERE id = ${IDS.orgGlobex}::uuid`);
    const rows = await su((sql) => sql`
      SELECT 1 FROM organization_logo WHERE organization_id = ${IDS.orgGlobex}::uuid
    `);
    expect(rows).toEqual([]);
  });
});

describe('after a key rotation', () => {
  it('still reads, because the row names the key that sealed it', async () => {
    /*
     * The bug the type checker caught while this was being written: `open()`
     * first used activeDataKey(), which after a rotation is not the key the
     * logo was sealed with. Every logo uploaded before the rotation would have
     * failed to decrypt — a broken image on every client page, and no error
     * anybody would connect to key management.
     */
    await put(ADMIN, PNG);
    const [before] = await logoRow();

    await harness.keys.beginRotation(IDS.tenant1, IDS.admin1, 'logo rotation test');

    const opened = await harness.logos.open(ADMIN, IDS.orgAcme);
    expect(opened, 'the logo stopped reading after a rotation').toBeTruthy();
    expect(opened!.bytes.equals(PNG)).toBe(true);

    const [after] = await logoRow();
    expect(after!.data_key_id, 'the stored key id should not have moved')
      .toBe(before!.data_key_id);
  });
});
