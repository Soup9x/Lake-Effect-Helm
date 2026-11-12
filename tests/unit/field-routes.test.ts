/**
 * Field view is read-only on the server (1250), and that rule lives in the
 * API's identity resolver. A route that finds the signed-in person through
 * getServerIdentity() instead never passes through it, which is how an
 * administrator's reset link and the authenticator setup were reachable from a
 * phone session. Each such route now applies the rule itself, with
 * refuseFieldWrite().
 *
 * This walks every route file so the NEXT one cannot be forgotten: a route
 * that calls getServerIdentity() and can be reached with anything but GET must
 * call refuseFieldWrite().
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fieldMayCall } from '../../src/lib/auth/field-session';

const APP = join(__dirname, '..', '..', 'src', 'app');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

describe('routes that authenticate through getServerIdentity()', () => {
  const files = routeFiles(APP);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('each refuse a Field view session before any write', () => {
    const unguarded = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      const writes = /export const (POST|PUT|PATCH|DELETE)\b/.test(source);
      return writes && source.includes('getServerIdentity(') && !source.includes('refuseFieldWrite(');
    });
    expect(unguarded.map((f) => f.slice(APP.length))).toEqual([]);
  });
});

describe('what a Field view session may call', () => {
  it('reads, and the audited reveals, and nothing that changes an account', () => {
    expect(fieldMayCall('GET', '/api/organizations')).toBe(true);
    expect(fieldMayCall('POST', '/api/auth/field/upgrade')).toBe(true);
    for (const path of ['/api/auth/local/reset', '/api/account/totp', '/api/auth/local/change-password']) {
      expect(fieldMayCall('POST', path), path).toBe(false);
    }
    expect(fieldMayCall('DELETE', '/api/account/totp')).toBe(false);
  });
});
