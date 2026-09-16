/**
 * Master key rotation: `pnpm helm:rotate-kek`.
 *
 * Moves every tenant's wrapped DEK onto the current KEK version. The DEK itself
 * does not change, so no field ciphertext is touched and secrets stay readable
 * throughout — this is one UPDATE per tenant key, not a re-encryption.
 *
 * Do not confuse it with DATA key rotation (`TenantKeyService.beginRotation`),
 * which mints a new DEK and does require re-encrypting every secret. Rotate the
 * master key when the master key is suspect; rotate the data key when a
 * tenant's data is.
 *
 * The order that matters, for local-keyfile:
 *
 *   1. Add the new version to the key ring and point "current" at it.
 *      KEEP the old version. Restart Helm.
 *   2. Run this. It re-wraps every DEK onto the new version.
 *   3. Confirm a clean run — "0 left on an older KEK version".
 *   4. Only then remove the old version from the key ring.
 *
 * Removing the old version before step 3 completes is unrecoverable: nothing
 * else in the system can open those DEKs. This script therefore reports what it
 * could NOT re-wrap as loudly as what it could, and exits non-zero.
 *
 * Usage:
 *   pnpm helm:rotate-kek --dry-run
 *   pnpm helm:rotate-kek --reason "annual master key rotation"
 *   pnpm helm:rotate-kek --tenant <uuid> --reason "..."
 */
import { closeAllPools } from '../src/lib/db/client';
import { describeKeyCustody, getKeyService } from '../src/lib/services';

interface Options {
  dryRun: boolean;
  reason: string;
  tenants: string[];
  actorId: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    reason: 'master key rotation',
    tenants: [],
    // The audit row needs an actor. A rotation run by an operator at a shell is
    // attributed to the configured maintenance identity rather than being left
    // null, so "who re-wrapped these keys" has an answer.
    actorId: process.env.HELM_MAINTENANCE_ACTOR_ID ?? '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--reason') options.reason = argv[++i] ?? options.reason;
    else if (arg === '--tenant') {
      const value = argv[++i];
      if (value) options.tenants.push(value);
    } else if (arg === '--actor') options.actorId = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: pnpm helm:rotate-kek [--dry-run] [--reason <text>] [--tenant <uuid>]... [--actor <uuid>]',
      );
      process.exit(0);
    } else if (arg) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.dryRun && !options.actorId) {
    throw new Error(
      'set HELM_MAINTENANCE_ACTOR_ID or pass --actor <uuid>: every key operation is attributed',
    );
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Resolving custody first turns a misconfigured key ring into an immediate,
  // legible failure rather than one discovered after the first tenant.
  const custody = describeKeyCustody();
  console.log(`key custody : ${custody.custody}`);
  console.log(`provider    : ${custody.provider}`);
  if (custody.detail.current) console.log(`current KEK : ${String(custody.detail.current)}`);
  if (custody.detail.versions) {
    console.log(`key ring    : ${(custody.detail.versions as string[]).join(', ')}`);
  }
  console.log('');

  const keys = getKeyService();
  const tenants = await keys.tenantsWithKeys();
  const selected = options.tenants.length
    ? tenants.filter((t) => options.tenants.includes(t.tenantId))
    : tenants;

  if (options.tenants.length && selected.length !== options.tenants.length) {
    const found = new Set(selected.map((t) => t.tenantId));
    throw new Error(`no such tenant: ${options.tenants.filter((t) => !found.has(t)).join(', ')}`);
  }

  if (options.dryRun) {
    console.log(`${selected.length} tenant(s), ${selected.reduce((n, t) => n + t.keyCount, 0)} live key(s):`);
    for (const tenant of selected) {
      console.log(`  ${tenant.name.padEnd(32)} ${tenant.keyCount} key(s)`);
    }
    console.log('\n--dry-run: nothing was written.');
    return;
  }

  let rewrapped = 0;
  let unchanged = 0;
  const failures: string[] = [];

  for (const tenant of selected) {
    const result = await keys.rewrapUnderCurrentKek(tenant.tenantId, options.actorId, options.reason);
    rewrapped += result.rewrapped;
    unchanged += result.unchanged;

    for (const failure of result.failed) {
      failures.push(`${tenant.name} generation ${failure.generation} (${failure.kekId}): ${failure.reason}`);
    }

    console.log(
      `${tenant.name.padEnd(32)} re-wrapped ${result.rewrapped}, already current ${result.unchanged}` +
        (result.failed.length ? `, FAILED ${result.failed.length}` : ''),
    );
  }

  console.log(`\n${rewrapped} key(s) re-wrapped, ${unchanged} already on the current KEK version.`);

  if (failures.length) {
    console.error('\nFAILED — do NOT remove the previous KEK version:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('0 left on an older KEK version. The previous version can now be retired.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
