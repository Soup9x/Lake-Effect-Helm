/**
 * First-run bootstrap: `pnpm helm:bootstrap`.
 *
 * After the migrations there is a schema and nothing in it — no tenant, no
 * user, no membership, and no data key. Helm is fail-closed by design, so an
 * empty database is not a half-working system, it is a completely inert one:
 * every policy denies, and there is nobody to sign in as.
 *
 * This creates the minimum that makes the deployment usable, and it exists as
 * a command rather than as four SQL statements in a setup guide because two of
 * the four are easy to get wrong in ways that are not obvious:
 *
 *   * The MSP root tenant and the first membership have to be inserted by a
 *     role that RLS does not constrain. `tenant` has no INSERT policy at all —
 *     deliberately, since creating an MSP is a deployment act, not something
 *     the application should ever do — so this runs on the migrator connection
 *     and only this.
 *
 *   * The first data key must be minted through the KEK provider, not
 *     inserted. A row in tenant_data_key that was not produced by
 *     TenantKeyService is a wrapped key nothing can unwrap, and the failure
 *     surfaces later as "we cannot decrypt anything".
 *
 * Refuses to run twice against the same tenant slug. Safe to read before
 * running: it writes four rows and mints one key.
 *
 * Usage:
 *   pnpm helm:bootstrap --tenant "Northwind Managed Services" \
 *                       --slug northwind \
 *                       --admin-email admin@northwind.example.com \
 *                       --admin-name "Dana Whitfield"
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { closeAllPools } from '../src/lib/db/client';
import { describeKeyCustody, getKeyService } from '../src/lib/services';

interface Options {
  tenantName: string;
  slug: string;
  adminEmail: string;
  adminName: string;
}

function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`expected --flag value pairs, got: ${argv.slice(i).join(' ')}`);
    }
    values[key.slice(2)] = value;
  }

  const tenantName = values.tenant;
  const slug = values.slug;
  const adminEmail = values['admin-email'];
  const adminName = values['admin-name'] ?? adminEmail;

  if (!tenantName || !slug || !adminEmail) {
    throw new Error(
      'usage: pnpm helm:bootstrap --tenant "<MSP name>" --slug <slug> ' +
        '--admin-email <email> [--admin-name "<name>"]',
    );
  }

  // The slug appears in URLs and in the tenant header; a loose one turns into a
  // support call the first time somebody types a capital letter.
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    throw new Error(`slug must be 3-40 lowercase letters, digits or hyphens: got "${slug}"`);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    throw new Error(`that does not look like an email address: "${adminEmail}"`);
  }

  // adminName falls back to adminEmail above, so it is defined by this point;
  // the narrowing is lost through the Record<string, string> index signature.
  return { tenantName, slug, adminEmail, adminName: adminName ?? adminEmail };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Resolve key custody FIRST. A misconfigured master key should stop the
  // bootstrap here, with a legible message, rather than after the tenant and
  // the administrator exist and only the key mint fails.
  const custody = describeKeyCustody();
  console.log(`key custody : ${custody.custody}`);
  console.log(`provider    : ${custody.provider}`);
  if (custody.hostHoldsMasterKey) {
    console.log(
      'note        : this host can read the master key. A database compromise\n' +
        '              alone yields nothing usable, but root on this box can\n' +
        '              decrypt everything offline, with no record.',
    );
  }
  console.log('');

  const tenantId = randomUUID();
  const userId = randomUUID();

  // Its OWN connection, deliberately not one of the five pools in
  // src/lib/db/client.ts. That registry is the product's privilege separation,
  // and adding a superuser role to it would put an unconstrained connection
  // within reach of anything that calls db(). A deployment script can hold its
  // own handle and close it.
  const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
  if (!migratorUrl) {
    throw new Error(
      'DATABASE_URL_MIGRATOR is not set. Bootstrap inserts the root tenant, ' +
        'which has no INSERT policy for any runtime role — by design.',
    );
  }

  const sql = postgres(migratorUrl, { max: 1, onnotice: () => {} });

  try {
    await sql.begin(async (tx) => {
      const [existing] = await tx<{ id: string; name: string }[]>`
        SELECT id, name FROM tenant WHERE slug = ${options.slug}::citext
      `;
      if (existing) {
        throw new Error(
          `tenant "${options.slug}" already exists (${existing.name}). ` +
            'Bootstrap runs once; add further users through the application.',
        );
      }

      const [existingUser] = await tx<{ id: string }[]>`
        SELECT id FROM app_user WHERE email = ${options.adminEmail}::citext
      `;
      if (existingUser) {
        throw new Error(`a user with email ${options.adminEmail} already exists`);
      }

      await tx`
        INSERT INTO tenant (id, slug, name, status)
        VALUES (${tenantId}::uuid, ${options.slug}::citext, ${options.tenantName}, 'active')
      `;

      await tx`
        INSERT INTO app_user (id, email, name)
        VALUES (${userId}::uuid, ${options.adminEmail}::citext, ${options.adminName})
      `;

      // super_admin with tenant-wide scope: the first account has to be able to
      // create the organisations and invite the people who will do everything
      // else. Narrow it, or replace it, once a second administrator exists.
      await tx`
        INSERT INTO membership (tenant_id, user_id, role_key, status, org_scope_all)
        VALUES (${tenantId}::uuid, ${userId}::uuid, 'super_admin', 'active', true)
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log(`tenant      : ${options.tenantName} (${options.slug})`);
  console.log(`              ${tenantId}`);
  console.log(`administrator: ${options.adminName} <${options.adminEmail}>`);
  console.log(`              ${userId}`);

  // Minted through the provider, never inserted. This is the key every secret
  // in the tenant will be encrypted under.
  const key = await getKeyService().provision(tenantId, userId, {
    reason: 'initial provisioning at bootstrap',
  });

  console.log(`data key    : generation ${key.generation}, wrapped by ${key.kekId}`);
  console.log('');
  console.log('Sign-in is next. Helm ships with Microsoft Entra ID as its only');
  console.log('provider, so configure AUTH_MICROSOFT_ENTRA_ID_* and sign in as');
  console.log(`${options.adminEmail} — the address must match the one Entra asserts.`);
  console.log('See docs/deployment/on-premises.md §5.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
