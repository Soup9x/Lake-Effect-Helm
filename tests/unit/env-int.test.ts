/**
 * Integer settings and the client address (lib/env.ts, auth/identity.ts).
 *
 * Reading a setting with `Number(...)` and a `??` default turned a typo into NaN. For
 * HELM_TRUSTED_PROXY_HOPS that NaN made clientIp() take the leftmost,
 * client-supplied X-Forwarded-For entry, defeating API token IP allowlists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envInt } from '../../src/lib/env';
import { clientIp } from '../../src/lib/auth/identity';

const withXff = (value: string, extra: Record<string, string> = {}) =>
  ({ headers: new Headers({ 'x-forwarded-for': value, ...extra }) });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('envInt', () => {
  it('uses the fallback when unset or blank', () => {
    expect(envInt('X', undefined, 20, { min: 1, max: 100 })).toBe(20);
    expect(envInt('X', '  ', 20, { min: 1, max: 100 })).toBe(20);
  });

  it('accepts a whole number in range', () => {
    expect(envInt('X', ' 15 ', 20, { min: 1, max: 100 })).toBe(15);
  });

  it('names the variable when the value is wrong, rather than becoming NaN', () => {
    expect(() => envInt('DATABASE_POOL_MAX', 'twenty', 20, { min: 2, max: 500 })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => envInt('X', '1.5', 20, { min: 1, max: 100 })).toThrow();
    expect(() => envInt('X', '0', 20, { min: 1, max: 100 })).toThrow();
  });
});

describe('clientIp', () => {
  it('reads from the right, one trusted hop by default', () => {
    expect(clientIp(withXff('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
  });

  it('refuses a malformed hop count instead of trusting the leftmost entry', () => {
    vi.stubEnv('HELM_TRUSTED_PROXY_HOPS', 'two');
    expect(() => clientIp(withXff('6.6.6.6, 203.0.113.9'))).toThrow(/HELM_TRUSTED_PROXY_HOPS/);
  });

  it('returns nothing rather than a value that is not an address', () => {
    expect(clientIp(withXff('6.6.6.6, unknown'))).toBeUndefined();
    expect(clientIp({ headers: new Headers({ 'x-real-ip': 'not-an-ip' }) })).toBeUndefined();
  });
});
