import { describe, expect, it } from 'vitest';
import {
  deviceTypeFor, mapDevice, primaryIpFor, primaryMacFor, serialFor,
  byDevice, mapLocation, mapProfile,
} from '../../src/lib/ninja/devices';
import type { NinjaDevice } from '../../src/lib/ninja/client';

const LAPTOP: NinjaDevice = {
  id: 1042,
  organizationId: 7,
  nodeClass: 'WINDOWS_WORKSTATION',
  displayName: 'Reception laptop',
  systemName: 'ACME-LT-04',
  dnsName: 'acme-lt-04.acme.local',
  lastContact: 1_760_000_000.25,
  ipAddresses: ['127.0.0.1', '169.254.10.1', '10.2.0.44', 'fe80::1'],
  macAddresses: ['00-15-5D-AA-BB-01'],
  os: { name: 'Windows 11 Pro', buildNumber: '22631', releaseId: '23H2' },
  system: { manufacturer: 'Dell Inc.', model: 'Latitude 5440', serialNumber: '7XK2LM3', chassisType: 'LAPTOP' },
  processors: [{ name: 'Intel(R) Core(TM) i5-1345U' }],
  memory: { capacity: 17_179_869_184 },
};

describe('a NinjaOne device as a Helm configuration', () => {
  it('maps what NinjaOne observes to device columns', () => {
    const mapped = mapDevice(LAPTOP);
    expect(mapped).toMatchObject({
      externalId: '1042',
      ninjaOrgId: '7',
      name: 'Reception laptop',
      deviceType: 'laptop',
    });
    expect(mapped.values).toEqual({
      hostname: 'ACME-LT-04',
      fqdn: 'acme-lt-04.acme.local',
      operating_system: 'Windows 11 Pro',
      os_version: '23H2 (22631)',
      manufacturer: 'Dell Inc.',
      model: 'Latitude 5440',
      serial_number: '7XK2LM3',
      cpu: 'Intel(R) Core(TM) i5-1345U',
      memory_gb: 16,
      primary_ip: '10.2.0.44',
      primary_mac: '00:15:5d:aa:bb:01',
      rmm_device_id: '1042',
      last_seen_at: new Date(1_760_000_000_250).toISOString(),
    });
  });

  it('leaves out what NinjaOne did not report, rather than clearing it', () => {
    const mapped = mapDevice({ id: 9, nodeClass: 'LINUX_SERVER', systemName: 'web01' });
    expect(mapped.values).toEqual({ hostname: 'web01', rmm_device_id: '9' });
    expect(mapped.name).toBe('web01');
    expect(mapped.deviceType).toBe('server');
    expect(mapped.ninjaOrgId).toBeNull();
  });

  it('hashes without the check-in time, so a machine that only checked in costs no writes', () => {
    const a = mapDevice(LAPTOP);
    const b = mapDevice({ ...LAPTOP, lastContact: LAPTOP.lastContact! + 3600 });
    const c = mapDevice({ ...LAPTOP, os: { ...LAPTOP.os, buildNumber: '26100' } });
    expect(b.sha256.equals(a.sha256)).toBe(true);
    expect(c.sha256.equals(a.sha256)).toBe(false);
  });

  it('names a device from what it has', () => {
    expect(mapDevice({ id: 1, dnsName: 'printer.acme.local' }).name).toBe('printer.acme.local');
    expect(mapDevice({ id: 2 }).name).toBe('NinjaOne device 2');
  });
});

describe('node classes', () => {
  it.each([
    ['WINDOWS_SERVER', undefined, 'server'],
    ['MAC', undefined, 'workstation'],
    ['WINDOWS_WORKSTATION', 'Notebook', 'laptop'],
    ['WINDOWS_WORKSTATION', 'DESKTOP', 'workstation'],
    ['VMWARE_VM_GUEST', undefined, 'virtual_machine'],
    ['HYPERV_VMM_HOST', undefined, 'hypervisor'],
    ['NMS_FIREWALL', undefined, 'firewall'],
    ['NMS_WAP', undefined, 'access_point'],
    ['CLOUD_MONITOR_TARGET', undefined, 'other'],
    [undefined, undefined, 'other'],
  ] as const)('%s (%s) is a %s', (nodeClass, chassisType, expected) => {
    expect(deviceTypeFor({
      ...(nodeClass ? { nodeClass } : {}),
      ...(chassisType ? { system: { chassisType } } : {}),
    })).toBe(expected);
  });
});

describe('serial numbers', () => {
  it('skips the placeholders manufacturers leave', () => {
    expect(serialFor({ system: { serialNumber: 'To Be Filled By O.E.M.', biosSerialNumber: 'ABC123' } })).toBe('ABC123');
    expect(serialFor({ system: { serialNumber: 'Default string' } })).toBeNull();
    expect(serialFor({ system: { serialNumber: '0000000' } })).toBeNull();
    expect(serialFor({ system: { serialNumber: ' CZ1234 ' } })).toBe('CZ1234');
  });
});

describe('addresses', () => {
  it('prefers a routable IPv4, then a usable IPv6', () => {
    expect(primaryIpFor(['127.0.0.1', '192.168.1.20'])).toBe('192.168.1.20');
    expect(primaryIpFor(['fe80::1', '2001:db8::5'])).toBe('2001:db8::5');
    expect(primaryIpFor(['999.1.1.1'])).toBeNull();
    expect(primaryIpFor(undefined)).toBeNull();
  });

  it('normalises a MAC and skips empty ones', () => {
    expect(primaryMacFor(['00:00:00:00:00:00', 'AABBCCDDEEFF'])).toBe('aa:bb:cc:dd:ee:ff');
    expect(primaryMacFor(['not a mac'])).toBeNull();
  });
});

describe('mapProfile', () => {
  it('reads warranty dates in either spelling and leaves unknown reports out', () => {
    const profile = mapProfile(
      { id: 7, warranty: { startDate: 1_700_000_000, endDate: '2027-03-01T00:00:00Z' } },
      {},
      'https://eu.ninjarmm.com',
    );
    expect(profile).toEqual({
      ninjaUrl: 'https://eu.ninjarmm.com/#/deviceDashboard/7/overview',
      warranty: { startsAt: new Date(1_700_000_000_000).toISOString(), endsAt: '2027-03-01T00:00:00.000Z' },
    });
    expect(mapProfile({ id: 'x', warrantyEndDate: 1_800_000_000_000 }, {}, 'https://app.ninjarmm.com'))
      .toEqual({ warranty: { endsAt: new Date(1_800_000_000_000).toISOString() } });
  });

  it('says none when a report has nothing for the device', () => {
    const profile = mapProfile({ id: 1 }, { antivirus: byDevice([]), patches: byDevice([]) }, 'https://app.ninjarmm.com');
    expect(profile.antivirus).toEqual([]);
    expect(profile.pendingPatches).toEqual({ total: 0, critical: 0 });
  });
});

describe('mapLocation', () => {
  it('folds a multi-line address onto one line', () => {
    expect(mapLocation({ id: 3, name: ' HQ ', address: '1 Main St\n  Suite 2\nTown' }))
      .toEqual({ externalId: '3', name: 'HQ', address: '1 Main St, Suite 2, Town' });
    expect(mapLocation({ id: 4 })).toEqual({ externalId: '4', name: 'NinjaOne location 4', address: null });
  });
});
