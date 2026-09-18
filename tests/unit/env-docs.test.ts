/**
 * Every configuration value is documented, and every documented value is real.
 *
 * This project has had to clean up undocumented and stale environment variables
 * twice. A one-off audit fixes the instance; this fixes the class.
 *
 * The audit at the time of writing found four:
 *
 *   HELM_STEP_UP_TTL_MINUTES   documented AND set in docker-compose.yml, read
 *                              by nothing. It appeared to bound how long a
 *                              step-up verification gates a credential reveal.
 *                              helm.step_up_verified() is a plain boolean with
 *                              no expiry, so the window it promised did not
 *                              exist.
 *   HELM_AUDIT_MIRROR_BUCKET   documented, read by nothing. Anchoring the audit
 *                              chain off-host is an operational control Helm
 *                              does not perform.
 *   NEXTAUTH_URL               read by code, documented nowhere. The Auth.js v4
 *                              name, on a v5 project — an undocumented variable
 *                              silently overriding a documented one.
 *   HELM_MIGRATE_VERBOSE       read by db/migrate.ts, documented nowhere.
 *
 * Two are scanned for:
 *
 *   USED BUT UNDOCUMENTED   an operator cannot configure what nobody wrote down.
 *   DOCUMENTED BUT UNREAD   worse, because it reads as a working control. A
 *                           variable that appears to gate a credential reveal
 *                           and does not is the failure this test exists for.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Read indirectly, so a `process.env.NAME` scan cannot see them. Each entry
 * names WHERE it is read — an entry whose claim stops being true is a comment
 * somebody has to correct rather than a silent exemption.
 */
const INDIRECT: Record<string, string> = {
  // src/lib/db/client.ts: process.env[ROLE_ENV[role]]
  DATABASE_URL_AUTH: 'db/client.ts ROLE_ENV',
  DATABASE_URL_WORKER: 'db/client.ts ROLE_ENV',
  DATABASE_URL_AUDITOR: 'db/client.ts ROLE_ENV',
  DATABASE_URL_KEY_ADMIN: 'db/client.ts ROLE_ENV',
  // src/lib/crypto/kek-vault.ts and kek-local.ts destructure `env` first.
  VAULT_TOKEN: 'kek-vault.ts env.VAULT_TOKEN',
  VAULT_SECRET_ID: 'kek-vault.ts env.VAULT_SECRET_ID',
  VAULT_NAMESPACE: 'kek-vault.ts env.VAULT_NAMESPACE',
  VAULT_APPROLE_MOUNT: 'kek-vault.ts env.VAULT_APPROLE_MOUNT',
  HELM_VAULT_TIMEOUT_MS: 'kek-vault.ts env.HELM_VAULT_TIMEOUT_MS',
  HELM_KEK_B64: 'kek-local.ts',
  HELM_KEK_FILE: 'kek-local.ts',
};

/** Read by a dependency or by the runtime, never by Helm's own code. */
const EXTERNAL: Record<string, string> = {
  AUTH_SECRET: 'Auth.js reads this itself',
  NODE_EXTRA_CA_CERTS: 'Node reads this at start-up, before any Helm code runs',
};

/** Supplied by the environment, not configuration an operator sets for Helm. */
const AMBIENT = new Set([
  'NODE_ENV', 'CI', 'PATH', 'HOME', 'TZ', 'VITEST',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSOCK', 'PGSUPERUSER',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

function usedInCode(): Set<string> {
  const names = new Set<string>();
  for (const dir of ['src', 'db', 'scripts', 'tests']) {
    for (const file of walk(join(ROOT, dir))) {
      // This file writes `process.env.NAME` in prose to describe the scan, and
      // the scan duly found NAME. Excluded rather than reworded, because the
      // next person to explain the rule would hit the same thing.
      if (file.endsWith('env-docs.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
        names.add(match[1]!);
      }
    }
  }
  return names;
}

function documented(): Set<string> {
  const source = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)) names.add(match[1]!);
  return names;
}

describe('.env.example', () => {
  const used = usedInCode();
  const docs = documented();

  it('documents every variable the code reads', () => {
    const missing = [...used].filter((n) => !docs.has(n) && !AMBIENT.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it('documents nothing the code does not read', () => {
    // The failure that matters more: a variable an operator sets, believing it
    // does something.
    const stale = [...docs]
      .filter((n) => !used.has(n) && !INDIRECT[n] && !EXTERNAL[n])
      .sort();
    expect(stale).toEqual([]);
  });

  it('keeps the indirect-read exemptions honest', () => {
    // An exemption for a variable that is no longer in .env.example is an
    // exemption nobody removed, which is how the list rots into a rubber stamp.
    const orphaned = [...Object.keys(INDIRECT), ...Object.keys(EXTERNAL)]
      .filter((n) => !docs.has(n))
      .sort();
    expect(orphaned).toEqual([]);
  });

  it('does not set anything in compose that nothing reads', () => {
    /*
     * Some configuration is consumed OUTSIDE TypeScript entirely — the Caddy
     * config expands {$HELM_PUBLIC_HOST}, and deploy/setup.sh writes and reads
     * several. Those are real reads by anything but a `process.env` scan, so
     * the deploy artefacts are scanned as sources too.
     *
     * Found by this test on its first run: HELM_PUBLIC_HOST looked stale under
     * a code-only scan and is in fact what the reverse proxy serves on.
     */
    const deployText = ['deploy/Caddyfile', 'deploy/setup.sh', 'deploy/init-secrets.sh']
      .map((f) => {
        try {
          return readFileSync(join(ROOT, f), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');

    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    const set = new Set<string>();
    for (const match of compose.matchAll(/^\s{2,}([A-Z_][A-Z0-9_]{2,}):/gm)) {
      set.add(match[1]!);
    }
    const stale = [...set]
      .filter(
        (n) =>
          !used.has(n) &&
          !INDIRECT[n] &&
          !EXTERNAL[n] &&
          !AMBIENT.has(n) &&
          !deployText.includes(n) &&
          // Consumed by the postgres image and by compose itself.
          !/^(POSTGRES_|HELM_DB_PASSWORD|PGDATA|LANG)/.test(n),
      )
      .sort();
    expect(stale).toEqual([]);
  });
});
