import { afterEach, describe, expect, it } from 'vitest';
import {
  NinjaError, fetchToken, listOrganizations, signIn, useNinjaRetryDelays, useNinjaTransport,
} from '../../src/lib/ninja/client';

const target = { baseUrl: 'https://us2.ninjarmm.com', clientId: 'client-1', clientSecret: 'secret-value' };

afterEach(() => {
  useNinjaTransport(null);
  useNinjaRetryDelays(null);
});

describe('the NinjaOne client', () => {
  it('fetches a fresh token once when NinjaOne refuses the one it gave', async () => {
    useNinjaRetryDelays([0, 0]);
    let tokens = 0;
    const seen: string[] = [];
    useNinjaTransport(async (url, request) => {
      if (url.endsWith('/ws/oauth/token')) {
        tokens += 1;
        return { status: 200, body: JSON.stringify({ access_token: `t${tokens}` }) };
      }
      seen.push(request.headers.authorization!);
      return request.headers.authorization === 'Bearer t1'
        ? { status: 401, body: '{"resultCode":"FAILURE"}' }
        : { status: 200, body: JSON.stringify([{ id: 1, name: 'Acme' }]) };
    });
    const auth = await signIn(target);
    expect(await listOrganizations(target, auth)).toEqual([{ id: 1, name: 'Acme' }]);
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
    expect(auth.token).toBe('t2');
  });

  it('says which step was refused, and what to check, when the fresh token is refused too', async () => {
    useNinjaRetryDelays([0, 0]);
    let tokens = 0;
    useNinjaTransport(async (url) => {
      if (url.endsWith('/ws/oauth/token')) {
        tokens += 1;
        return { status: 200, body: JSON.stringify({ access_token: `t${tokens}` }) };
      }
      return { status: 401, body: '{"error":"invalid_token"}' };
    });
    const error = await listOrganizations(target, await signIn(target)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NinjaError);
    expect((error as NinjaError).kind).toBe('unauthorized');
    expect((error as NinjaError).message).toMatch(/refused it while reading \/api\/v2\/organizations \(invalid_token\)/);
    expect((error as NinjaError).remedy).toMatch(/Monitoring scope/);
    expect(tokens).toBe(2);
  });

  it('tries a request NinjaOne does not answer three times before failing, naming the host and step', async () => {
    useNinjaRetryDelays([0, 0]);
    let calls = 0;
    useNinjaTransport(async () => {
      calls += 1;
      throw new Error('The operation was aborted due to timeout');
    });
    const error = await fetchToken(target).catch((e: unknown) => e);
    expect(calls).toBe(3);
    expect((error as NinjaError).kind).toBe('unreachable');
    expect((error as NinjaError).message).toBe(
      'NinjaOne did not answer at us2.ninjarmm.com while getting a token (The operation was aborted due to timeout, 3 tries)',
    );
  });

  it('gets through a blip: a timeout, then a 503, then an answer', async () => {
    useNinjaRetryDelays([0, 0]);
    let calls = 0;
    useNinjaTransport(async () => {
      calls += 1;
      if (calls === 1) throw new Error('The operation was aborted due to timeout');
      if (calls === 2) return { status: 503, body: '<html>maintenance</html>' };
      return { status: 200, body: JSON.stringify({ access_token: 'tok' }) };
    });
    expect(await fetchToken(target)).toBe('tok');
    expect(calls).toBe(3);
  });

  it('includes NinjaOne\'s reason when the secret is refused', async () => {
    useNinjaTransport(async () => ({ status: 401, body: '{"error":"invalid_client","error_description":"Client authentication failed"}' }));
    await expect(fetchToken(target)).rejects.toThrow('NinjaOne refused the client id and secret (Client authentication failed)');
  });

  it('does not renew a bare token', async () => {
    let tokens = 0;
    useNinjaTransport(async (url) => {
      if (url.endsWith('/ws/oauth/token')) { tokens += 1; return { status: 200, body: '{"access_token":"x"}' }; }
      return { status: 401, body: '' };
    });
    await expect(listOrganizations(target, 'bare')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(tokens).toBe(0);
  });
});
