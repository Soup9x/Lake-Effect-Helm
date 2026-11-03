/**
 * Field view (1250): the allow-list a read-only phone session is held to, the
 * audit marker on what it does, and where its links go.
 */
import { describe, expect, it } from 'vitest';
import {
  FIELD_USER_AGENT_MARK, fieldMayCall, isFieldUserAgent, markFieldUserAgent,
} from '../../src/lib/auth/field-session';
import { fieldHref } from '../../src/lib/field/queries';

const ID = '7920e4d3-06d2-428e-8581-0861b29a67ae';

describe('fieldMayCall', () => {
  it('lets every read through', () => {
    for (const path of ['/api/organizations', `/api/secrets/${ID}`, '/api/anything/at/all']) {
      expect(fieldMayCall('GET', path)).toBe(true);
      expect(fieldMayCall('head', path)).toBe(true);
    }
  });

  it('lets the audited reads and the session managing itself through', () => {
    for (const path of [
      `/api/secrets/${ID}/reveal`, `/api/secrets/${ID}/copy`, `/api/assets/${ID}/totp/code`,
      `/api/personal/vault/${ID}/reveal`, `/api/personal/vault/${ID}/code`,
      '/api/auth/step-up', '/api/auth/field/enter', '/api/auth/field/upgrade', '/api/auth/local/logout',
    ]) {
      expect(fieldMayCall('POST', path), path).toBe(true);
    }
  });

  it('refuses every other write, including near misses on the list', () => {
    for (const [method, path] of [
      ['POST', '/api/organizations'],
      ['PUT', `/api/secrets/${ID}/reveal`],
      ['DELETE', `/api/secrets/${ID}`],
      ['POST', `/api/secrets/${ID}/rotate`],
      ['POST', `/api/secrets/${ID}/reveal/extra`],
      ['POST', `/api/secrets/not-a-uuid-at-all-but-thirty-six-chars!/reveal`],
      ['POST', `/x/api/secrets/${ID}/reveal`],
      ['PATCH', '/api/tenant/field-view'],
      ['PUT', '/api/tenant/field-view'],
      ['POST', '/api/auth/session-policy/end-sessions'],
    ] as const) {
      expect(fieldMayCall(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe('the "from phone" marker', () => {
  it('prefixes the user agent, and is recognised only at the start', () => {
    const marked = markFieldUserAgent('Mozilla/5.0 (iPhone)');
    expect(marked.startsWith(FIELD_USER_AGENT_MARK)).toBe(true);
    expect(isFieldUserAgent(marked)).toBe(true);
    expect(isFieldUserAgent(markFieldUserAgent(undefined))).toBe(true);
    expect(isFieldUserAgent('Mozilla/5.0 (iPhone)')).toBe(false);
    expect(isFieldUserAgent(`Mozilla ${FIELD_USER_AGENT_MARK}`)).toBe(false);
    expect(isFieldUserAgent(null)).toBe(false);
  });
});

describe('fieldHref', () => {
  it('sends each kind of result to its Field view page', () => {
    expect(fieldHref({ kind: 'client', organizationId: ID })).toBe(`/m/c/${ID}`);
    expect(fieldHref({ kind: 'credential', organizationId: ID, nodeId: 'n1' })).toBe('/m/s/n1');
    expect(fieldHref({ kind: 'credential', organizationId: ID })).toBe(`/m/c/${ID}?tab=logins`);
    expect(fieldHref({ kind: 'asset', organizationId: ID, nodeId: 'n2', nodeType: 'device' })).toBe('/m/a/n2');
    expect(fieldHref({ kind: 'asset', organizationId: ID, nodeId: 'n3', nodeType: 'credential' })).toBe('/m/s/n3');
    expect(fieldHref({ kind: 'contact', organizationId: ID })).toBe(`/m/c/${ID}?tab=contacts`);
    expect(fieldHref({ kind: 'site', organizationId: ID })).toBe(`/m/c/${ID}?tab=locations`);
    expect(fieldHref({ kind: 'document', organizationId: null })).toBe('/m');
  });
});
