/**
 * Deleting an applied migration is drift. This is what notices.
 *
 * THE FINDING. Removing a file from db/sql TOGETHER WITH its MANIFEST.sha256
 * entry passed every check the project had. Each comparison started from the
 * files on disk and looked each one up in the reference, so a file that should
 * exist and does not was never looked up — there was no iteration it could
 * appear in. The manifest no longer mentioned it either. `--against` walked the
 * tree the same way. The one step that did notice was a git diff of db/sql in
 * CI, and it ran only on `pull_request`, while the workflow also triggers on
 * `push: branches: ['**']` — so a direct push to a branch went green.
 *
 * Deleting an applied migration does not un-apply it. Every environment that
 * ran it still carries its effects and a fresh build no longer reproduces them:
 * the same divergence as an edit, and harder to see, because there is no file
 * left to read.
 *
 * HOW THIS IS TESTED. Against a real git repository with real files, running
 * the real script, rather than against a reimplementation of what it does. The
 * script resolves db/sql relative to its OWN path, so the fixture gets a copy
 * of it and everything runs inside a throwaway directory — the repository these
 * tests live in is never touched.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Three migrations, enough for "one of these is gone" to be a real statement. */
const FILES: Record<string, string> = {
  '0000_bootstrap.sql': '-- bootstrap\nCREATE SCHEMA helm;\n',
  '0010_tenancy.sql': '-- tenancy\nCREATE TABLE tenant (id uuid PRIMARY KEY);\n',
  '0020_identity.sql': '-- identity\nCREATE TABLE app_user (id uuid PRIMARY KEY);\n',
};

let fixture: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeManifest(names: string[]): void {
  const body = names
    .sort()
    .map((name) => `${sha256(readFileSync(join(fixture, 'db', 'sql', name), 'utf8'))}  ${name}`)
    .join('\n');
  writeFileSync(join(fixture, 'db', 'sql', 'MANIFEST.sha256'), `# fixture manifest\n\n${body}\n`);
}

/** The real script, in the fixture, with its exit code and combined output. */
function check(...args: string[]): { code: number; output: string } {
  try {
    // tsx from THIS repo, the script from the fixture: the script resolves
    // db/sql from its own path, so where the binary lives does not matter.
    const output = execFileSync(
      TSX,
      [join(fixture, 'scripts', 'check-migrations.ts'), ...args],
      { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
    );
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'helm-migrations-'));
  mkdirSync(join(fixture, 'db', 'sql'), { recursive: true });
  mkdirSync(join(fixture, 'scripts'), { recursive: true });

  // The script under test, not a copy of its logic.
  cpSync(join(REPO, 'scripts', 'check-migrations.ts'), join(fixture, 'scripts', 'check-migrations.ts'));
  for (const [name, body] of Object.entries(FILES)) {
    writeFileSync(join(fixture, 'db', 'sql', name), body);
  }
  writeManifest(Object.keys(FILES));

  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'three migrations and a manifest');
});

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

/** Put the fixture back to its committed state between cases. */
function restore(): void {
  git('checkout', '--quiet', '--', '.');
  git('clean', '--quiet', '-fd');
}

describe('a clean tree', () => {
  it('passes every mode', () => {
    restore();
    expect(check().code).toBe(0);
    expect(check('--against', 'HEAD').code).toBe(0);
    expect(check('--deleted-since', 'HEAD').code).toBe(0);
  });

  it('says how many migrations it checked, so a vacuous pass is visible', () => {
    restore();
    expect(check().output).toContain('3 migrations match MANIFEST.sha256');
    expect(check('--against', 'HEAD').output).toContain('all 3 migrations at HEAD');
  });
});

// -----------------------------------------------------------------------------
// The original finding, reproduced exactly: the file AND its manifest entry.
// -----------------------------------------------------------------------------
describe('an applied migration is deleted together with its manifest entry', () => {
  beforeAll(() => {
    restore();
    rmSync(join(fixture, 'db', 'sql', '0010_tenancy.sql'));
    writeManifest(['0000_bootstrap.sql', '0020_identity.sql']);
  });

  it('fails the manifest check, which used to report success', () => {
    const result = check();

    expect(result.code).toBe(1);
    expect(result.output).toContain('0010_tenancy.sql');
    expect(result.output).toMatch(/MISSING from this tree/);
    // The exact sentence the old run printed instead.
    expect(result.output).not.toContain('✓ 2 migrations match MANIFEST.sha256');
  });

  it('fails --against, which walked the tree and so never looked', () => {
    const result = check('--against', 'HEAD');

    expect(result.code).toBe(1);
    expect(result.output).toContain('0010_tenancy.sql');
  });

  it('fails --deleted-since', () => {
    const result = check('--deleted-since', 'HEAD');

    expect(result.code).toBe(1);
    expect(result.output).toContain('0010_tenancy.sql');
  });

  it('says what a deletion actually costs, not just that a file is missing', () => {
    expect(check().output).toMatch(/does not un-apply it/);
    expect(check().output).toMatch(/git checkout HEAD -- db\/sql\//);
  });

  it('refuses --update, which is what the refusal above tempts you to type', () => {
    // Re-recording the manifest without the file is exactly the sequence that
    // made this invisible. A check you can silence by running the tool again
    // is not a check.
    const result = check('--update');

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/--update will not record a deletion/);
    // ...and it did not quietly write the manifest on its way out.
    expect(readFileSync(join(fixture, 'db', 'sql', 'MANIFEST.sha256'), 'utf8')).toContain(
      '# fixture manifest',
    );
  });

  it('...unless --force, for a migration that has never shipped anywhere', () => {
    const result = check('--update', '--force');

    expect(result.code).toBe(0);
    // The escape hatch is real, and deliberately louder than the happy path.
    expect(check('--deleted-since', 'HEAD').code).toBe(1);
  });
});

describe('the file is deleted but the manifest entry is left behind', () => {
  it('is still caught, as it always was', () => {
    restore();
    rmSync(join(fixture, 'db', 'sql', '0010_tenancy.sql'));

    const result = check();

    expect(result.code).toBe(1);
    expect(result.output).toContain('0010_tenancy.sql');
  });
});

// -----------------------------------------------------------------------------
// Still doing its original job, and not inventing new failures.
// -----------------------------------------------------------------------------
describe('the checks it already had', () => {
  it('catches an edit to an applied migration', () => {
    restore();
    writeFileSync(join(fixture, 'db', 'sql', '0010_tenancy.sql'), '-- tenancy, edited\n');

    const manifestMode = check();
    expect(manifestMode.code).toBe(1);
    expect(manifestMode.output).toMatch(/EDITED IN PLACE/);

    const refMode = check('--against', 'HEAD');
    expect(refMode.code).toBe(1);
    expect(refMode.output).toMatch(/DIFFER from HEAD/);

    // Existence only: the file is right there. This is the separation that lets
    // the pre-commit hook compare against HEAD without flagging a legitimate
    // revision of a migration that has never shipped.
    expect(check('--deleted-since', 'HEAD').code).toBe(0);
  });

  it('catches a migration missing from the manifest', () => {
    restore();
    writeFileSync(join(fixture, 'db', 'sql', '0030_later.sql'), '-- later\n');

    const result = check();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/not recorded in the manifest/);
  });

  it('treats a migration written since the reference as expected, not as drift', () => {
    restore();
    writeFileSync(join(fixture, 'db', 'sql', '0030_later.sql'), '-- later\n');
    writeManifest([...Object.keys(FILES), '0030_later.sql']);

    expect(check().code).toBe(0);

    const refMode = check('--against', 'HEAD');
    expect(refMode.code).toBe(0);
    expect(refMode.output).toMatch(/1 written since it/);

    expect(check('--deleted-since', 'HEAD').code).toBe(0);
  });
});

describe('a reference it cannot use', () => {
  it('says so rather than passing', () => {
    restore();

    for (const args of [['--against', 'no-such-ref'], ['--deleted-since', 'no-such-ref']]) {
      const result = check(...args);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/cannot read db\/sql at no-such-ref/);
    }
  });

  it('refuses a ref with no migrations in it at all, instead of calling it clean', () => {
    restore();
    // An empty commit on an orphan branch: a real ref, no db/sql. Answering
    // "nothing is missing" from it would be true and useless.
    git('checkout', '--quiet', '--orphan', 'empty');
    git('rm', '-r', '--quiet', '--cached', '.');
    git('commit', '--quiet', '--allow-empty', '-m', 'no migrations here');
    const emptyRef = git('rev-parse', 'HEAD').trim();
    git('checkout', '--quiet', '--force', 'main');
    restore();

    const result = check('--deleted-since', emptyRef);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/contains no db\/sql/);
  });

  it('needs an argument', () => {
    restore();
    expect(check('--deleted-since').code).toBe(1);
    expect(check('--deleted-since').output).toMatch(/needs a git ref/);
  });
});
