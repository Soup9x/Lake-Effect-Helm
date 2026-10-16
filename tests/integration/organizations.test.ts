/**
 * The clients list: relationship, status grouping and the filters behind them.
 *
 * WHAT THESE TESTS ARE FOR. 0600 added a column that overlaps two existing
 * ones on purpose — `status` already had 'prospect' and `is_msp_internal`
 * already meant "us" — and the whole argument for adding it rests on the two
 * axes being independent. So the first test here is the one that would have
 * caught the CHECK constraint the migration header describes rejecting: it
 * stores relationship 'prospect' with status 'former' and expects that to be
 * allowed, because a prospect that went cold is a real thing to record.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  ACTIVE_STATUSES,
  RELATIONSHIP_KEYS,
  isActiveStatus,
  relationshipOf,
} from '../../src/lib/ui/organization-relationship';
import { initialsOf } from '../../src/components/client-avatar';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { POST as postOrganization } from '../../src/app/api/organizations/route';
import { readOrganization } from '../../src/lib/clients/queries';
import { PATCH as patchOrganization } from '../../src/app/api/organizations/[organizationId]/route';

let h: Harness;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const asActor = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' as const };

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => ADMIN);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

const json = (body: unknown) =>
  new NextRequest('http://helm.test/api/organizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------

describe('the relationship catalogue', () => {
  it('agrees with the values the database will accept', async () => {
    // Two copies of one list — the organization_relationship enum and
    // RELATIONSHIP_KEYS. Adding a label to the interface without a migration
    // produces a write the enum refuses, which is a 500 on a save nobody can
    // explain. This turns that into a failure here instead.
    const sql = superuserSql();
    try {
      const rows = await sql<{ label: string }[]>`
        SELECT enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'organization_relationship'
        ORDER BY e.enumsortorder
      `;
      expect(rows.map((r) => r.label)).toEqual([...RELATIONSHIP_KEYS]);
    } finally {
      await sql.end();
    }
  });

  it('every key has a label and a tone the badge palette defines', () => {
    const tones = new Set(['neutral', 'brand', 'ok', 'info', 'notice', 'warning', 'critical', 'expired', 'danger']);
    for (const key of RELATIONSHIP_KEYS) {
      const meta = relationshipOf(key);
      expect(meta.label.length, key).toBeGreaterThan(0);
      expect(tones.has(meta.tone), `${key} uses tone ${meta.tone}`).toBe(true);
    }
  });

  it('falls back to client rather than throwing on an unknown value', () => {
    // A column read is not a validation site. A row written by a future
    // migration this build has not seen should render, not crash the page.
    expect(relationshipOf('something_new').key).toBe('client');
    expect(relationshipOf(null).key).toBe('client');
  });
});

// ---------------------------------------------------------------------------

describe('relationship is independent of status', () => {
  it('allows a prospect that went cold: relationship prospect, status former', async () => {
    // THE TEST THAT REJECTS THE CONSTRAINT 0600 ALMOST SHIPPED. The first draft
    // had CHECK ((relationship = 'prospect') = (status = 'prospect')), which
    // forbids exactly this row. If somebody adds that constraint later, this
    // fails and the header explains why.
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO organization (tenant_id, slug, name, status, relationship)
        VALUES (
          ${IDS.tenant1}::uuid, 'cold-lead', 'Cold Lead Ltd',
          'former'::organization_status, 'prospect'::organization_relationship
        )
      `;
      const [row] = await sql<{ status: string; relationship: string }[]>`
        SELECT status::text, relationship::text FROM organization WHERE slug = 'cold-lead'
      `;
      expect(row).toEqual({ status: 'former', relationship: 'prospect' });
    } finally {
      await sql.end();
    }
  });

  it('backfilled the MSP organisation to internal and left clients as client', async () => {
    // Named rows rather than a table scan. A scan would be read AFTER the other
    // tests in this file have created vendors and competitors, and would then
    // be asserting their behaviour rather than the backfill's.
    await withTenant(asActor, async (tx) => {
      const rows = await tx<{ id: string; is_msp_internal: boolean; relationship: string }[]>`
        SELECT id::text, is_msp_internal, relationship::text AS relationship
        FROM organization
        WHERE id = ANY(ARRAY[${IDS.orgInternal}, ${IDS.orgAcme}, ${IDS.orgGlobex}]::uuid[])
      `;
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(IDS.orgInternal)).toMatchObject({
        is_msp_internal: true,
        relationship: 'internal',
      });
      expect(byId.get(IDS.orgAcme)).toMatchObject({
        is_msp_internal: false,
        relationship: 'client',
      });
      expect(byId.get(IDS.orgGlobex)).toMatchObject({
        is_msp_internal: false,
        relationship: 'client',
      });
    });
  });

  it('keeps is_msp_internal unique, so internal is a label and that is not', async () => {
    // Marking a second organisation relationship 'internal' is allowed — it is
    // a label. Setting is_msp_internal on a second one is not, and the unique
    // index from 0010 is what still enforces that after 0600.
    const sql = superuserSql();
    try {
      // Inside a transaction that always rolls back: this test is about what
      // the constraint refuses, and leaving Acme relabelled behind it would
      // make the backfill assertion above depend on execution order.
      await expect(
        sql.begin(async (tx) => {
          await tx`
            UPDATE organization SET relationship = 'internal'
            WHERE id = ${IDS.orgAcme}::uuid
          `;
          // Allowed: 'internal' is a label, so a second one is fine.
          const [labelled] = await tx<{ relationship: string }[]>`
            SELECT relationship::text FROM organization WHERE id = ${IDS.orgAcme}::uuid
          `;
          expect(labelled?.relationship).toBe('internal');

          // Refused: is_msp_internal is unique per tenant, and 0600 did not
          // widen it. This is what throws, and it takes the transaction with it.
          await tx`
            UPDATE organization SET is_msp_internal = true WHERE id = ${IDS.orgAcme}::uuid
          `;
        }),
      ).rejects.toThrow();

      const [after] = await sql<{ relationship: string }[]>`
        SELECT relationship::text FROM organization WHERE id = ${IDS.orgAcme}::uuid
      `;
      expect(after?.relationship).toBe('client');
    } finally {
      await sql.end();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the status grouping', () => {
  it('counts onboarding, active and co_managed as active and the rest as not', () => {
    // ITG offers Active/Inactive; Helm's enum has six stages. The filter groups
    // them and the column shows the real stage, so this is the only place the
    // mapping is written down.
    expect([...ACTIVE_STATUSES]).toEqual(['onboarding', 'active', 'co_managed']);
    for (const status of ACTIVE_STATUSES) expect(isActiveStatus(status)).toBe(true);
    for (const status of ['prospect', 'offboarding', 'former']) {
      expect(isActiveStatus(status), status).toBe(false);
    }
  });

  it('every status in the database enum is classified one way or the other', async () => {
    // Guards the case where a migration adds a seventh stage: it would silently
    // be "inactive" here, and this names it instead.
    const sql = superuserSql();
    try {
      const rows = await sql<{ label: string }[]>`
        SELECT enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'organization_status'
      `;
      expect(rows.map((r) => r.label).sort()).toEqual(
        ['active', 'co_managed', 'former', 'offboarding', 'onboarding', 'prospect'].sort(),
      );
    } finally {
      await sql.end();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the API carries relationship', () => {
  it('defaults to client when the caller does not say', async () => {
    const response = await postOrganization(
      json({ name: 'Default Co', slug: 'default-co' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { organization: { relationship: string } };
    expect(body.organization.relationship).toBe('client');
  });

  it('persists what the caller sends, and PATCH moves it without touching status', async () => {
    const created = await postOrganization(
      json({ name: 'Acme Supply', slug: 'acme-supply', relationship: 'vendor' }),
    );
    const { organization } = (await created.json()) as {
      organization: { id: string; relationship: string };
    };
    expect(organization.relationship).toBe('vendor');

    const patched = await patchOrganization(
      new NextRequest(`http://helm.test/api/organizations/${organization.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relationship: 'competitor' }),
      }),
      { params: Promise.resolve({ organizationId: organization.id }) },
    );
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as {
      organization: { relationship: string; status: string };
    };
    expect(after.organization.relationship).toBe('competitor');
    // Untouched: the two columns move independently, which is the whole point.
    expect(after.organization.status).toBe('active');
  });

  it('reaches the client page, so the picker shows what the row holds', async () => {
    // The column existed, the API accepted it, the list filtered on it — and
    // the page read everything about an organisation except this, so no
    // control could show it. The page's own read now carries it.
    const created = await postOrganization(
      json({ name: 'Rival Inc', slug: 'rival-inc', relationship: 'competitor' }),
    );
    const { organization } = (await created.json()) as { organization: { id: string } };
    const row = await withTenant(asActor, (tx) => readOrganization(tx, organization.id));
    expect(row?.relationship).toBe('competitor');
  });

  it('refuses a relationship outside the enum', async () => {
    const response = await postOrganization(
      json({ name: 'Bad Type', slug: 'bad-type', relationship: 'partner' }),
    );
    // invalid_request maps to 400 in src/lib/api/errors.ts.
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsOf('Acme Manufacturing')).toBe('AM');
    expect(initialsOf('Globex')).toBe('G');
  });

  it('skips punctuation-only words, which is the case a naive split gets wrong', () => {
    // "Northwind (Internal)" splits into three words on whitespace and the
    // second starts with a bracket. NI is the answer; N( is what you get
    // without the filter.
    expect(initialsOf('Northwind (Internal)')).toBe('NI');
    expect(initialsOf('— Acme')).toBe('A');
  });

  it('never renders an empty circle', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('!!!')).toBe('?');
  });

  it('handles non-latin names', () => {
    expect(initialsOf('Ørsted Energi')).toBe('ØE');
    expect(initialsOf('東京 システム')).toBe('東シ');
  });
});
