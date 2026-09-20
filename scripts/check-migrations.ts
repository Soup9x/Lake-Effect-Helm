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
 * AND WHAT NEITHER COULD TELL YOU UNTIL NOW: that a migration is GONE.
 *
 * Every comparison here used to start from the files on disk and look each one
 * up in the reference. A file that should exist and does not was therefore
 * never looked up — there was no iteration it could appear in. Deleting an
 * applied migration TOGETHER WITH its manifest entry passed the manifest check
 * (the manifest no longer mentions it), passed --against (the loop walked the
 * tree), passed the pre-commit hook, and passed CI on a direct push, because
 * the one step that did notice — a git diff of db/sql — only ran on
 * pull_request while the workflow also triggers on push to every branch.
 *
 * Deleting an applied migration does not un-apply it. Every environment that
 * ran it still carries its effects and a fresh build no longer reproduces them,
 * which is the same divergence as an edit and harder to see.
 *
 * So the comparisons are driven by the REFERENCE now, not by the working tree:
 * the set of files considered is the reference's listing UNION the tree's, and
 * a name the reference has that the tree does not is a failure. --expect was
 * always this way, because helm_migration is unmistakably the reference; the
 * git-backed modes have been brought in line.
 *
 * `--against <ref>` compares db/sql against a git ref rather than against the
 * manifest, so "does this tree match the commit we deployed" is answerable:
 *
 *     pnpm db:check-migrations --against 95af761
 *
 * Files in the tree and absent from the ref are reported and not treated as
 * failures: a migration added since that commit is expected to be missing from
 * it. Files in the ref and absent from the TREE are the opposite case, and they
 * fail.
 *
 * `--deleted-since <ref>` asks only that one question, with no content
 * comparison at all:
 *
 *     pnpm db:check-migrations --deleted-since HEAD
 *
 * That separation matters where the reference is recent rather than deployed.
 * The pre-commit hook compares against HEAD, and a migration written in the
 * previous commit and revised in this one is a legitimate edit that --force
 * exists for; flagging it would teach people to pass --no-verify. Whether the
 * file still EXISTS is never a matter of judgement.
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

/**
 * The db/sql/*.sql names present in a git ref.
 *
 * This is the half that was missing: a reference has to be able to state what
 * SHOULD be there, or "it is not there" is unaskable. Returns null when the ref
 * does not resolve — no git, no history, no such commit. That is a different
 * situation from finding drift, and each caller decides what it means.
 */
function tryMigrationsAtRef(ref: string): string[] | null {
  let listing: string;
  try {
    listing = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', ref, '--', 'db/sql'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  return listing
    .split('\0')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.sql'))
    .map((line) => line.slice('db/sql/'.length));
}

/** The same, for the modes where the caller NAMED the ref and meant it. */
function migrationsAtRef(ref: string): string[] {
  const names = tryMigrationsAtRef(ref);
  if (names === null) {
    console.error(`✗ cannot read db/sql at ${ref} — no such ref, or not fetched`);
    console.error(
      '\n  A shallow clone often has not fetched it. In CI:\n' +
      `      git fetch --no-tags --depth=50 origin ${ref}\n`,
    );
    process.exit(1);
  }
  return names;
}

/** What a deletion costs, said once so both modes say the same thing. */
function reportDeleted(names: string[], ref: string): void {
  console.error(`✗ migrations present at ${ref} are MISSING from this tree:\n`);
  for (const name of names) console.error(`    db/sql/${name}`);
  console.error(
    '\n  Deleting an applied migration does not un-apply it. Every environment\n' +
    '  that ran it still carries its effects, and a fresh build no longer\n' +
    '  reproduces them — the same divergence as an edit, and harder to see\n' +
    '  because there is no file left to read.\n\n' +
    `  Restore each one:  git checkout ${ref} -- db/sql/<file>\n` +
    '  then: pnpm db:check-migrations --update\n\n' +
    '  If a migration genuinely must stop doing what it did, write a NEW one\n' +
    '  that undoes it. The file stays.\n',
  );
}

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

/** `--deleted-since <ref>`: the existence question alone, no content comparison. */
const deletedSinceIndex = argv.indexOf('--deleted-since');
const deletedSince = deletedSinceIndex >= 0 ? argv[deletedSinceIndex + 1] : undefined;

/** `--expect <file>`: compare the tree to an environment's helm_migration dump. */
const expectIndex = argv.indexOf('--expect');
const expectFile = expectIndex >= 0 ? argv[expectIndex + 1] : undefined;

if (deletedSinceIndex >= 0 && !deletedSince) {
  console.error('✗ --deleted-since needs a git ref, e.g. --deleted-since HEAD');
  process.exit(1);
}

if (deletedSince) {
  const files = migrations();
  const atRef = migrationsAtRef(deletedSince);

  if (atRef.length === 0) {
    console.error(`✗ ${deletedSince} contains no db/sql/*.sql at all`);
    console.error(
      '\n  That is not a clean tree, it is an unusable reference. Check the ref,\n' +
      '  and check that the clone is deep enough to contain it.\n',
    );
    process.exit(1);
  }

  // Driven by the ref, which is the whole point: a name the tree does not have
  // never appears in a walk of the tree.
  const deleted = atRef.filter((name) => !files.has(name));

  if (deleted.length > 0) {
    reportDeleted(deleted, deletedSince);
    process.exit(1);
  }

  const added = [...files.keys()].filter((name) => !atRef.includes(name));
  console.log(
    `✓ all ${atRef.length} migrations at ${deletedSince} are still in this tree` +
    (added.length > 0 ? `; ${added.length} added since it` : ''),
  );
  process.exit(0);
}

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
  // THE REFERENCE, not the tree. Walking the tree could only ever find files
  // that exist, so a deleted migration had no iteration to appear in.
  const atRef = migrationsAtRef(against);

  if (atRef.length === 0) {
    console.error(`✗ ${against} contains no db/sql/*.sql at all`);
    console.error(
      '\n  A reference with no migrations in it cannot answer anything. Check the\n' +
      '  ref, and check that the clone is deep enough to contain it.\n',
    );
    process.exit(1);
  }

  const drifted: string[] = [];
  const deleted: string[] = [];

  for (const name of atRef) {
    const onDisk = files.get(name);
    if (onDisk === undefined) {
      deleted.push(name);
      continue;
    }
    const content = execFileSync('git', ['show', `${against}:db/sql/${name}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (sha256(content) !== onDisk) drifted.push(name);
  }

  // In the tree and not in the ref: a migration written since. The expected
  // case, and not something to put in front of somebody during an incident.
  const added = [...files.keys()].filter((name) => !atRef.includes(name));

  if (drifted.length > 0) {
    console.error(`✗ these migrations DIFFER from ${against}:\n`);
    for (const name of drifted) console.error(`    db/sql/${name}`);
    console.error(
      `\n  If ${against} is what an environment actually applied, this is the\n` +
      '  drift that will fail its next deploy. Restore each file to its content\n' +
      `  at that commit (git show ${against}:db/sql/<file> > db/sql/<file>) and\n` +
      '  carry any intended change forward in a NEW migration.\n',
    );
  }

  if (deleted.length > 0) reportDeleted(deleted, against);

  if (drifted.length > 0 || deleted.length > 0) process.exit(1);

  console.log(
    `✓ all ${atRef.length} migrations at ${against} are present and unchanged` +
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

/**
 * ...and the case the manifest structurally cannot see.
 *
 * Delete a migration AND its manifest entry and everything above is satisfied:
 * the manifest does not mention the file, so nothing looks for it. The only
 * remaining record that the file ever existed is git, so that is what is asked.
 *
 * HEAD, deliberately. "No migration in the last commit may be missing from the
 * working tree" has no false positives — a file that was committed and is now
 * gone is always wrong — and it is true exactly where a person is about to
 * commit the deletion: the pre-commit hook, and `pnpm verify`. It is NOT true
 * once the deletion is itself committed, which is why CI names an older
 * reference explicitly; see --against and --deleted-since.
 *
 * A tree with no git (a release tarball, a fresh clone with no commits) says so
 * rather than failing. The manifest half of this check still works there, which
 * is what "works with no history" in the header means.
 */
const atHead = tryMigrationsAtRef('HEAD');
const deletedSinceHead = atHead === null ? [] : atHead.filter((name) => !files.has(name));

if (update) {
  const next = new Map(manifest);
  for (const name of added) next.set(name, files.get(name)!);

  // --update must not be the way round the deletion check. Removing the file
  // and then re-recording the manifest without it is EXACTLY the sequence that
  // made this invisible, and it is the natural next thing to type after the
  // bare check refuses.
  if (deletedSinceHead.length > 0 && !force) {
    reportDeleted(deletedSinceHead, 'HEAD');
    console.error(
      '  --update will not record a deletion. The manifest describes what is in\n' +
      '  db/sql; it cannot describe what has been taken out of it, and blessing\n' +
      '  the removal here is what made this invisible in the first place.\n\n' +
      '  If the file genuinely never reached any database — added in a branch\n' +
      '  that has not merged — re-run with --force. CI still compares against\n' +
      '  the merge base with the default branch, and will refuse it once the\n' +
      '  migration has shipped.',
    );
    process.exit(1);
  }

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

// Last, because it is the one the other three cannot state: a file that is
// gone from both the tree and the manifest leaves no trace in either.
if (deletedSinceHead.length > 0) {
  failed = true;
  reportDeleted(deletedSinceHead, 'HEAD');
  console.error(
    '  Removing its manifest entry as well is what made this look clean. The\n' +
    '  manifest records what the tree contains; it cannot record an absence.\n',
  );
}

if (failed) process.exit(1);

console.log(
  `✓ ${files.size} migrations match MANIFEST.sha256` +
  (atHead === null
    ? '; no git history here, so deletions are unchecked'
    : `; all ${atHead.length} at HEAD still present`),
);
