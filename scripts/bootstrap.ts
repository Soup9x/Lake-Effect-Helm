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
 * It also sets a local password on the administrator it creates, printed once
 * and never stored. That is not a convenience: Entra takes a support ticket and
 * a redirect URI to configure, and until it is done there is no way into the
 * deployment at all. More importantly it establishes the break-glass account on
 * day one, rather than on the morning somebody discovers they need one.
 *
 * Refuses to run twice against the same tenant slug. Safe to read before
 * running: it writes five rows and mints one key.
 *
 * Usage:
 *   pnpm helm:bootstrap --tenant "Northwind Managed Services" \
 *                       --slug northwind \
 *                       --admin-email admin@northwind.example.com \
 *                       --admin-name "Dana Whitfield"
 */
import { randomInt, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { closeAllPools } from '../src/lib/db/client';
import { hashPassword, checkPasswordPolicy } from '../src/lib/auth/password';
import { describeKeyCustody, getKeyService } from '../src/lib/services';

interface Options {
  tenantName: string;
  slug: string;
  adminEmail: string;
  adminName: string;
}

/**
 * Words for the generated password.
 *
 * A passphrase rather than a random string, because this one gets read aloud,
 * typed from a terminal into a browser, and occasionally written on paper for
 * an hour. "correct-horse-battery-staple" survives all three; a base64 blob
 * produces a transcription error and a locked-out administrator.
 *
 * Short, unambiguous, no homophones and no words that differ only by a letter
 * that sounds like another over a phone line.
 */
const WORDS = [
  'anchor', 'amber', 'arrow', 'basin', 'beacon', 'birch', 'bridge', 'canyon',
  'cedar', 'cobalt', 'compass', 'copper', 'coral', 'dune', 'ember', 'fathom',
  'ferry', 'flint', 'forge', 'garnet', 'gravel', 'harbor', 'hollow', 'indigo',
  'ivory', 'juniper', 'kettle', 'lantern', 'ledger', 'lichen', 'marble',
  'meadow', 'mercury', 'mosaic', 'nickel', 'orchard', 'otter', 'pebble',
  'pewter', 'pillar', 'quarry', 'quartz', 'rafter', 'ripple', 'saddle',
  'sequoia', 'shale', 'silver', 'spruce', 'sterling', 'summit', 'thicket',
  'timber', 'trestle', 'tundra', 'velvet', 'walnut', 'willow', 'window',
  'zephyr',
];

/**
 * Generate the initial password.
 *
 * Five words from a 60-word list is about 29 bits, which on its own is not
 * enough for a credential vault. The two digits take it to roughly 36, and the
 * three things that actually carry the weight are that it is MUST-CHANGE, that
 * it is rate-limited and locked out after five wrong guesses, and that it is
 * alive for as long as it takes the administrator to sign in once.
 *
 * randomInt is the CSPRNG. Math.random() here would be a genuinely exploitable
 * mistake: the output is the only credential in a brand-new deployment.
 */
function generatePassphrase(): string {
  const words = Array.from({ length: 5 }, () => WORDS[randomInt(WORDS.length)]!);
  return `${words.join('-')}-${String(randomInt(10, 100))}`;
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

  // Generated and hashed BEFORE the transaction: Argon2id at Helm's parameters
  // takes about a quarter of a second, and holding a transaction open across it
  // for no reason is a habit worth not forming.
  //
  // The policy check is not ceremony. It asserts that this script cannot
  // produce a password the application would refuse — a generator that drifts
  // out of step with the policy produces an administrator who cannot sign in,
  // discovered at the worst moment.
  const initialPassword = generatePassphrase();
  const policy = checkPasswordPolicy(initialPassword, {
    email: options.adminEmail,
    name: options.adminName,
  });
  if (!policy.ok) {
    throw new Error(
      `the generated password does not satisfy Helm's own policy (${policy.problems.join('; ')}). ` +
        'This is a bug in scripts/bootstrap.ts, not something you did.',
    );
  }
  const passwordPhc = await hashPassword(initialPassword);

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

      // must_change: this password was chosen by a script and printed to a
      // terminal, which means it is in a scrollback buffer and possibly in a
      // terminal recording. It is a way in, once, not a password.
      await tx`
        INSERT INTO local_credential (user_id, password_phc, must_change)
        VALUES (${userId}::uuid, ${passwordPhc}, true)
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

  // Printed once, at the end, after everything that could fail has succeeded.
  // Printing it earlier would put a live credential on the screen of a run that
  // then aborts, leaving an operator unsure whether it means anything.
  console.log('─'.repeat(72));
  console.log('  INITIAL PASSWORD — shown once, stored nowhere.');
  console.log('');
  console.log(`      ${options.adminEmail}`);
  console.log(`      ${initialPassword}`);
  console.log('');
  console.log('  Sign in with it at /sign-in and change it immediately; Helm will');
  console.log('  insist. It is in this terminal\'s scrollback, so treat it as');
  console.log('  compromised the moment it has been used.');
  console.log('─'.repeat(72));
  console.log('');
  console.log('Microsoft Entra ID is the other way in. Configure');
  console.log('AUTH_MICROSOFT_ENTRA_ID_* and sign in as the same address — it must');
  console.log('match what Entra asserts. Keep the local password working as well:');
  console.log('it is what gets you in when Entra cannot be reached.');
  console.log('See docs/deployment/on-premises.md §5.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
