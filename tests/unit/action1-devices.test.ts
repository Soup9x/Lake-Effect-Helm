import { afterEach, describe, expect, it } from 'vitest';
import {
  action1Time, deviceTypeFor, mapEndpoint, mapProfile, memoryGbFrom, serialFor, splitOs,
} from '../../src/lib/action1/devices';
import {
  fetchToken, listAllEndpoints, listOrganizationEndpoints, useAction1Transport, Action1Error,
  type Action1Endpoint, type Action1Request,
} from '../../src/lib/action1/client';
import { action1EndpointsUrl, action1OrganizationUrl } from '../../src/lib/action1/links';

/** Shaped like the Endpoint example in Action1's API specification. */
const LAPTOP: Action1Endpoint = {
  id: 'e1d2c3b4-0000-4000-8000-000000000001',
  organization_id: '88c8b425-871e-4ff6-9afc-00df8592c6db',
  name: 'Reception laptop',
  device_name: 'ACME-LT-04',
  address: '10.2.0.44',
  external_address: '203.0.113.7',
  MAC: '44:34:AB:FA:23:98',
  OS: 'Windows 11 (24H2)',
  platform: 'Windows',
  architecture: 'x64',
  agent_version: '5.317.722.1',
  last_seen: '2026-10-29_12-22-11',
  last_boot_time: '2026-10-27_07-01-00',
  user: 'ACME\\reception',
  manufacturer: 'Dell Inc.',
  serial: '7XK2LM3',
  CPU_name: 'Intel Core i5-1345U',
  CPU_size: '1.6 GHz, 10/12 Cores',
  RAM: '16Gb DDR4',
  disk: '477Gb SSD',
  AD_organization_unit: 'acme.local/HQ/Laptops',
  status: 'Connected',
  online_status: 'SUCCESS',
  reboot_required: 'Yes',
  vulnerability_status: 'WARNING',
  missing_updates: { critical: 2, other: 5 },
};

describe('an Action1 endpoint as a Helm configuration', () => {
  it('maps what Action1 observes to device columns', () => {
    const mapped = mapEndpoint(LAPTOP);
    expect(mapped).toMatchObject({
      externalId: LAPTOP.id,
      action1OrgId: LAPTOP.organization_id,
      name: 'Reception laptop',
      deviceType: 'workstation',
      values: {
        hostname: 'ACME-LT-04',
        operating_system: 'Windows 11',
        os_version: '24H2',
        manufacturer: 'Dell Inc.',
        serial_number: '7XK2LM3',
        cpu: 'Intel Core i5-1345U',
        memory_gb: 16,
        primary_ip: '10.2.0.44',
        primary_mac: '44:34:ab:fa:23:98',
        last_seen_at: '2026-10-29T12:22:11.000Z',
      },
    });
    // Never NinjaOne's id column.
    expect(mapped.values).not.toHaveProperty('rmm_device_id');
  });

  it('hashes without the check-in time, so a check-in alone is not a change', () => {
    const a = mapEndpoint(LAPTOP);
    const b = mapEndpoint({ ...LAPTOP, last_seen: '2026-10-30_01-00-00' });
    expect(a.sha256.equals(b.sha256)).toBe(true);
    expect(mapEndpoint({ ...LAPTOP, RAM: '32Gb DDR4' }).sha256.equals(a.sha256)).toBe(false);
  });

  it('reports nothing it was not told', () => {
    const mapped = mapEndpoint({ id: '9' });
    expect(mapped.values).toEqual({});
    expect(mapped.name).toBe('Action1 endpoint 9');
    expect(mapped.action1OrgId).toBeNull();
  });

  it('reads Action1 times as UTC, and ISO too', () => {
    expect(action1Time('2022-08-29_12-22-11')).toBe('2022-08-29T12:22:11.000Z');
    expect(action1Time('2022-08-29T12:22:11Z')).toBe('2022-08-29T12:22:11.000Z');
    expect(action1Time('yesterday')).toBeNull();
    expect(action1Time(undefined)).toBeNull();
  });

  it('reads memory in the spellings Action1 uses', () => {
    expect(memoryGbFrom('32Gb DDR4')).toBe(32);
    expect(memoryGbFrom('DDR4 16 GB')).toBe(16);
    expect(memoryGbFrom('8192 MB')).toBe(8);
    expect(memoryGbFrom('1 TB')).toBe(1024);
    expect(memoryGbFrom('64')).toBe(64);
    expect(memoryGbFrom('DDR4')).toBeNull();
    expect(memoryGbFrom('')).toBeNull();
  });

  it('splits an operating system from its release', () => {
    expect(splitOs('Windows Server 2022 (21H2)')).toEqual({ name: 'Windows Server 2022', version: '21H2' });
    expect(splitOs('macOS Sonoma')).toEqual({ name: 'macOS Sonoma', version: null });
  });

  it('types a machine from its OS and maker, defaulting to a workstation', () => {
    expect(deviceTypeFor({ OS: 'Windows Server 2022 (21H2)', platform: 'Windows' })).toBe('server');
    expect(deviceTypeFor({ OS: 'Windows 11 (24H2)', manufacturer: 'VMware, Inc.' })).toBe('virtual_machine');
    expect(deviceTypeFor({ OS: 'Ubuntu 22.04', platform: 'Linux', manufacturer: 'QEMU' })).toBe('virtual_machine');
    expect(deviceTypeFor({ OS: 'Ubuntu 22.04', platform: 'Linux' })).toBe('server');
    expect(deviceTypeFor({ OS: 'macOS Sonoma', platform: 'Mac' })).toBe('workstation');
    expect(deviceTypeFor({})).toBe('workstation');
  });

  it('drops placeholder serial numbers', () => {
    expect(serialFor({ serial: 'To be filled by O.E.M.' })).toBeNull();
    expect(serialFor({ serial: ' 0 ' })).toBeNull();
    expect(serialFor({ serial: 'VMware-56 4d 1a' })).toBe('VMware-56 4d 1a');
  });
});

describe('the From Action1 card', () => {
  it('carries status, updates, reboot and the rest', () => {
    expect(mapProfile(LAPTOP)).toEqual({
      orgId: LAPTOP.organization_id,
      agentStatus: 'Connected',
      onlineStatus: 'SUCCESS',
      lastLoggedInUser: 'ACME\\reception',
      lastBootAt: '2026-10-27T07:01:00.000Z',
      needsReboot: true,
      publicIp: '203.0.113.7',
      platform: 'Windows',
      architecture: 'x64',
      processor: '1.6 GHz, 10/12 Cores',
      disk: '477Gb SSD',
      adOrganizationUnit: 'acme.local/HQ/Laptops',
      agentVersion: '5.317.722.1',
      missingUpdates: { critical: 2, other: 5 },
      vulnerabilityStatus: 'WARNING',
    });
  });

  it('reads the flat missing-update counts, as strings, too', () => {
    expect(mapProfile({ id: '1', missing_critical_updates: '0', missing_other_updates: '3' }).missingUpdates)
      .toEqual({ critical: 0, other: 3 });
  });

  it('says nothing about updates when Action1 gave no counts', () => {
    expect(mapProfile({ id: '1' })).toEqual({});
  });
});

describe('links into Action1', () => {
  it('goes to the organization in the console, on the regional host', () => {
    expect(action1OrganizationUrl('https://app.eu.action1.com', 'abc-123'))
      .toBe('https://app.eu.action1.com/console/dashboard?org=abc-123');
    expect(action1EndpointsUrl('https://app.action1.com', 'abc-123'))
      .toBe('https://app.action1.com/console/endpoints?org=abc-123');
    expect(action1OrganizationUrl('https://app.action1.com', 'x/../y')).toBeNull();
    expect(action1EndpointsUrl('https://app.action1.com', undefined)).toBeNull();
  });
});

describe('the Action1 client', () => {
  const calls: { url: string; request: Action1Request }[] = [];
  afterEach(() => {
    calls.length = 0;
    useAction1Transport(null);
  });

  const target = { baseUrl: 'https://app.action1.com', clientId: 'api-key-1@action1.com', clientSecret: 'secret-value' };

  it('asks for a token with JSON, at the region chosen', async () => {
    useAction1Transport(async (url, request) => {
      calls.push({ url, request });
      return { status: 200, body: JSON.stringify({ access_token: 'jwt', expires_in: 3600, token_type: 'Bearer' }) };
    });
    expect(await fetchToken(target)).toBe('jwt');
    expect(calls[0]!.url).toBe('https://app.action1.com/api/3.0/oauth2/token');
    expect(JSON.parse(calls[0]!.request.body!)).toEqual({ client_id: target.clientId, client_secret: 'secret-value' });
  });

  it('says plainly when the credential is refused', async () => {
    useAction1Transport(async () => ({ status: 401, body: '{}' }));
    await expect(fetchToken(target)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('pages by offset until total_items, asking for every field', async () => {
    const items = Array.from({ length: 450 }, (_, i) => ({ id: `e${i}`, organization_id: 'o1' }));
    useAction1Transport(async (url, request) => {
      calls.push({ url, request });
      const q = new URL(url).searchParams;
      const from = Number(q.get('from') ?? 0);
      const limit = Number(q.get('limit'));
      return { status: 200, body: JSON.stringify({ type: 'ResultPage', items: items.slice(from, from + limit), total_items: String(items.length), limit: String(limit) }) };
    });
    const all = await listAllEndpoints(target, 'jwt');
    expect(all).toHaveLength(450);
    expect(calls.map((c) => new URL(c.url).search)).toEqual([
      '?fields=*&limit=200',
      '?fields=*&from=200&limit=200',
      '?fields=*&from=400&limit=200',
    ]);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/3.0/endpoints/managed/all');
    expect(calls[0]!.request.headers.authorization).toBe('Bearer jwt');
  });

  it('stamps one organization\'s endpoints with that organization', async () => {
    useAction1Transport(async () => ({ status: 200, body: JSON.stringify({ items: [{ id: 'e1' }], total_items: '1' }) }));
    expect(await listOrganizationEndpoints(target, 'jwt', 'org-9')).toEqual([{ id: 'e1', organization_id: 'org-9' }]);
  });

  it('waits out "too many requests", then gives up', async () => {
    const waits: number[] = [];
    let n = 0;
    useAction1Transport(async () => {
      n += 1;
      return n === 1 ? { status: 429, body: '', retryAfter: '3' } : { status: 200, body: JSON.stringify({ access_token: 'jwt' }) };
    }, async (ms) => { waits.push(ms); });
    expect(await fetchToken(target)).toBe('jwt');
    expect(waits).toEqual([3000]);

    useAction1Transport(async () => ({ status: 429, body: '' }), async (ms) => { waits.push(ms); });
    await expect(fetchToken(target)).rejects.toBeInstanceOf(Action1Error);
  });
});
