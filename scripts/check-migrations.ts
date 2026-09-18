#!/usr/bin/env tsx
/**
 * Applied migrations are immutable. This is what notices when one changes.
 *
 * WHY THIS EXISTS
 *
 * db/migrate.ts already refuses to run when a file's sha256 no longer matches
 * what helm_migration recorded — but it finds out at DEPLOY TIME, against a
 * live database, on somebody's evening. By then the edit is merged, the release
 * is cut, and the person holding the pager did not write it.
 *
 * Seven migrations had drifted before this file existed. Three were pure
 * comment changes that would still have failed every deploy, because the
 * checksum covers the whole file and does not care what the bytes mean. Two
 * were edits to seed files, which is the quiet case: the checksum breaks AND
 * the edit would not have worked anyway, because seeds run once and changing an
 * INSERT literal does nothing to a row that already exists.
 *
 * MANIFEST.sha256 is the record of what each migration's content is. CI and the
 * pre-commit hook compare the tree against it, so the answer arrives while the
 * change is still being written.
 *
 * THE ESCAPE HATCH IS A NEW MIGRATION, ALWAYS.
 *
 * `--update` adds entries for NEW files. It will not rewrite an existing one:
 * that needs `--force`, which is correct only for a migration that has never
 * been deployed anywhere, and which the CI check against origin/main will
 * reject anyway once the file has shipped.
 *
 * WHAT THE MANIFEST CANNOT TELL YOU, and this is not a small caveat.
 *
 * It records what the tree contained when somebody ran `--update`. It answers
 * "has anything changed since we wrote this down" and nothing else. If the
 * tree was already wrong at that moment, the manifest faithfully records the
 * wrong thing and the check passes forever.
 *
 * That happened. A revert of 0340_local_authentication.sql went to the file's
 * INTRODUCING commit rather than to the content production had actually
 * applied — the file had been edited once BEFORE production's deploy point, so
 * those are different bytes — and the manifest was then generated from that
 * tree. Every check passed. The deploy failed, because the only authority on
 * what production ran is production's own helm_migration table.
 *
 * `--against <ref>` compares db/sql against a git ref rather than against the
 * manifest, so "does this tree match the commit we deployed" is answerable:
 *
 *     pnpm db:check-migrations --against 95af761
 *
 * Files absent from the ref are reported and not treated as failures: a
 * migration added since that commit is expected to be missing from it.
 *
 * `--expect <file>` is the one that actually settles it, because it does not
 * rely on knowing which commit an environment is on. It takes the environment's
 * OWN record — the rows in helm_migration — and compares them to the tree:
 *
 *     psql -At -F' ' -c 'SELECT filename, sha256 FROM helm_migration' > applied.txt
 *     pnpm db:check-migrations --expect applied.txt
 *
 * That is the authority. A commit is a guess about what an environment applied;
 * helm_migration is what it applied. Guessing produced two bad reverts here:
 * first to a file's introducing commit, then to a commit that turned out not to
 * be the deploy point either. One query would have answered it both times.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = join(ROOT, 'db', 'sql');
const MANIFEST = join(SQL_DIR, 'MANIFEST.sha256');

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function migrations(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    out.set(name, sha256(readFileSync(join(SQL_DIR, name), 'utf8')));
  }
  return out;
}

function readManifest(): Map<string, string> {
  const out = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(MANIFEST, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // `sha256sum` format: hash, two spaces, filename.
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(trimmed);
    if (!match) {
      console.error(`✗ MANIFEST.sha256 has a line that is not "<sha256>  <filename>":\n  ${trimmed}`);
      process.exit(1);
    }
    out.set(match[2]!, match[1]!);
  }
  return out;
}

function writeManifest(entries: Map<string, string>): void {
  const header =
    '# sha256 of every file in db/sql, in filename order.\n' +
    '#\n' +
    '# An applied migration is immutable: db/migrate.ts hashes the whole file and\n' +
    '# refuses to run when it no longer matches what helm_migration recorded. This\n' +
    '# manifest moves that failure from deploy time to commit time.\n' +
    '#\n' +
    '# Adding a migration:  pnpm db:check-migrations --update\n' +
    '# Changing one:        do not. Write a new migration that alters what it did.\n' +
    '\n';
  const body = [...entries.keys()]
    .sort()
    .map((name) => `${entries.get(name)}  ${name}`)
    .join('\n');
  writeFileSync(MANIFEST, `${header}${body}\n`);
}

const argv = process.argv.slice(2);
const args = new Set(argv);
const update = args.has('--update');
const force = args.has('--force');

/** `--against <ref>`: compare the tree to a git ref instead of to the manifest. */
const againstIndex = argv.indexOf('--against');
const against = againstIndex >= 0 ? argv[againstIndex + 1] : undefined;

/** `--expect <file>`: compare the tree to an environment's helm_migration dump. */
const expectIndex = argv.indexOf('--expect');
const expectFile = expectIndex >= 0 ? argv[expectIndex + 1] : undefined;

if (expectIndex >= 0 && !expectFile) {
  console.error('✗ --expect needs a file of "<filename> <sha256>" lines');
  process.exit(1);
}

if (expectFile) {
  const files = migrations();
  const applied = new Map<string, string>();

  for (const line of readFileSync(expectFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Accepts the psql -At -F' ' shape and the bare table output, so an
    // operator can paste either without reformatting.
    const match = /^([0-9a-zA-Z_.-]+\.sql)\s*\|?\s*([0-9a-f]{64})$/.exec(trimmed);
    if (match) applied.set(match[1]!, match[2]!);
  }

  if (applied.size === 0) {
    console.error(`✗ no "<filename> <sha256>" rows found in ${expectFile}`);
    process.exit(1);
  }

  const drifted: string[] = [];
  const missing: string[] = [];

  for (const [name, hash] of applied) {
    const onDisk = files.get(name);
    if (onDisk === undefined) missing.push(name);
    else if (onDisk !== hash) drifted.push(name);
  }

  if (drifted.length > 0 || missing.length > 0) {
    if (drifted.length > 0) {
      console.error('✗ the tree DIFFERS from what that environment applied:\n');
      for (const name of drifted) {
        console.error(`    db/sql/${name}`);
        console.error(`      it applied  ${applied.get(name)!.slice(0, 16)}…`);
        console.error(`      tree has    ${files.get(name)!.slice(0, 16)}…`);
      }
      console.error(
        '\n  Its next deploy fails on the first of these. Restore each file to the\n' +
        '  content it applied and carry any intended change forward in a NEW\n' +
        '  migration.\n',
      );
    }
    if (missing.length > 0) {
      console.error('✗ it applied migrations that are not in this tree:\n');
      for (const name of missing) console.error(`    ${name}`);
      console.error('\n  Deleting an applied migration does not un-apply it.\n');
    }
    process.exit(1);
  }

  const pending = [...files.keys()].filter((name) => !applied.has(name));
  console.log(
    `✓ all ${applied.size} applied migrations match the tree` +
    (pending.length > 0 ? `; ${pending.length} pending: ${pending.join(', ')}` : '; nothing pending'),
  );
  process.exit(0);
}

if (againstIndex >= 0 && !against) {
  console.error('✗ --against needs a git ref, e.g. --against 307b872');
  process.exit(1);
}

if (against) {
  const files = migrations();
  const drifted: string[] = [];
  const added: string[] = [];

  for (const [name] of files) {
    let atRef: string;
    try {
      atRef = execFileSync('git', ['show', `${against}:db/sql/${name}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // git writes "exists on disk, but not in <ref>" to stderr for every
        // migration added since the ref, which is the expected case and not
        // something to put in front of somebody running this during an incident.
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // Not in that commit. A migration written since then, which is the
      // normal case and not a problem.
      added.push(name);
      continue;
    }
    if (sha256(atRef) !== files.get(name)) drifted.push(name);
  }

  if (drifted.length > 0) {
    console.error(`✗ these migrations DIFFER from ${against}:\n`);
    for (const name of drifted) console.error(`    db/sql/${name}`);
    console.error(
      `\n  If ${against} is what an environment actually applied, this is the\n` +
      '  drift that will fail its next deploy. Restore each file to its content\n' +
      `  at that commit (git show ${against}:db/sql/<file> > db/sql/<file>) and\n` +
      '  carry any intended change forward in a NEW migration.\n',
    );
    process.exit(1);
  }

  console.log(
    `✓ ${files.size - added.length} migrations match ${against}` +
    (added.length > 0 ? `; ${added.length} written since it` : ''),
  );
  process.exit(0);
}

const files = migrations();
const manifest = readManifest();

const changed: string[] = [];
const added: string[] = [];
const removed: string[] = [];

for (const [name, hash] of files) {
  const recorded = manifest.get(name);
  if (recorded === undefined) added.push(name);
  else if (recorded !== hash) changed.push(name);
}
for (const name of manifest.keys()) {
  if (!files.has(name)) removed.push(name);
}

if (update) {
  const next = new Map(manifest);
  for (const name of added) next.set(name, files.get(name)!);

  if (changed.length > 0) {
    if (!force) {
      console.error('✗ these migrations have CHANGED, and --update will not bless a change:\n');
      for (const name of changed) console.error(`    ${name}`);
      console.error(
        '\n  An applied migration is immutable. Restore the file and write a new\n' +
        '  migration that alters what it did.\n\n' +
        '  If this migration has genuinely never been deployed anywhere — it was\n' +
        '  added in a branch that has not merged — re-run with --force. The CI\n' +
        '  check against origin/main will still refuse it once it has shipped.',
      );
      process.exit(1);
    }
    for (const name of changed) next.set(name, files.get(name)!);
    console.warn(`⚠ --force: re-recording ${changed.length} changed migration(s):`);
    for (const name of changed) console.warn(`    ${name}`);
  }

  for (const name of removed) next.delete(name);
  writeManifest(next);

  const summary = [
    added.length ? `${added.length} added` : null,
    force && changed.length ? `${changed.length} re-recorded` : null,
    removed.length ? `${removed.length} removed` : null,
  ].filter(Boolean);
  console.log(`✓ MANIFEST.sha256 updated${summary.length ? ` (${summary.join(', ')})` : ' (no changes)'}`);
  process.exit(0);
}

let failed = false;

if (changed.length > 0) {
  failed = true;
  console.error('✗ APPLIED MIGRATIONS HAVE BEEN EDITED IN PLACE\n');
  for (const name of changed) {
    console.error(`    db/sql/${name}`);
    console.error(`      recorded ${manifest.get(name)!.slice(0, 16)}…`);
    console.error(`      on disk  ${files.get(name)!.slice(0, 16)}…`);
  }
  console.error(
    '\n  db/migrate.ts hashes the WHOLE FILE, so a changed comment fails a deploy\n' +
    '  exactly as hard as a changed ALTER TABLE — and on a seed file the edit\n' +
    '  would not have taken effect anyway, because seeds run once.\n\n' +
    '  Restore the file (git checkout) and write a NEW migration carrying the\n' +
    '  change forward, guarded so it is correct on a database that ran either\n' +
    '  version.\n',
  );
}

if (removed.length > 0) {
  failed = true;
  console.error('✗ migrations in the manifest are missing from db/sql:\n');
  for (const name of removed) console.error(`    ${name}`);
  console.error(
    '\n  Deleting an applied migration does not un-apply it. Every environment\n' +
    '  that ran it still carries its effects, and a fresh build no longer\n' +
    '  reproduces them.\n',
  );
}

if (added.length > 0) {
  failed = true;
  console.error('✗ migrations are not recorded in the manifest:\n');
  for (const name of added) console.error(`    ${name}`);
  console.error('\n  Run: pnpm db:check-migrations --update\n');
}

if (failed) process.exit(1);

console.log(`✓ ${files.size} migrations match MANIFEST.sha256`);
