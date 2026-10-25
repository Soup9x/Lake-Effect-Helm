import { describe, expect, it } from 'vitest';
import { aliasesOf, domainsToImport, groupKind, isPerson, mapProfile, mapSku, mapUser } from '../../src/lib/m365/mapping';

const LICENSED = [{ skuId: 'sku-1' }];

describe('who becomes a contact', () => {
  it('is an enabled, licensed member', () => {
    expect(isPerson({ id: '1', accountEnabled: true, userType: 'Member', assignedLicenses: LICENSED })).toBe(true);
  });

  it('is not a shared mailbox, a guest or an unlicensed account', () => {
    expect(isPerson({ id: '2', accountEnabled: false, userType: 'Member', assignedLicenses: LICENSED })).toBe(false);
    expect(isPerson({ id: '3', accountEnabled: true, userType: 'Guest', assignedLicenses: LICENSED })).toBe(false);
    expect(isPerson({ id: '4', accountEnabled: true, userType: 'Member', assignedLicenses: [] })).toBe(false);
  });
});

describe('a user as a contact', () => {
  it('takes the names, title, address and numbers Microsoft 365 holds', () => {
    const mapped = mapUser({
      id: 'u-1', givenName: 'Grace', surname: 'Hopper', jobTitle: 'Office manager',
      mail: 'Grace.Hopper@Acme.test', businessPhones: ['+1 555 0100'], mobilePhone: '+1 555 0199',
    });
    expect(mapped.values).toEqual({
      first_name: 'Grace', last_name: 'Hopper', title: 'Office manager',
      email: 'grace.hopper@acme.test', phone: '+1 555 0100', mobile: '+1 555 0199',
    });
  });

  it('splits a display name when there are no given and family names', () => {
    expect(mapUser({ id: 'u-2', displayName: 'Ada King Lovelace' }).values).toMatchObject({
      first_name: 'Ada King', last_name: 'Lovelace',
    });
    expect(mapUser({ id: 'u-3', displayName: 'Reception' }).values).toMatchObject({
      first_name: 'Reception', last_name: '',
    });
  });

  it('falls back to the sign-in name for an address, but not a guest one', () => {
    expect(mapUser({ id: 'u-4', givenName: 'A', userPrincipalName: 'a@acme.test' }).values.email).toBe('a@acme.test');
    expect(mapUser({ id: 'u-5', givenName: 'B', userPrincipalName: 'b_x.test#EXT#@acme.onmicrosoft.com' }).values.email)
      .toBeUndefined();
  });

  it('hashes what it records, so an unchanged user costs nothing', () => {
    const a = mapUser({ id: 'u', givenName: 'A', surname: 'B', jobTitle: 'X' });
    const b = mapUser({ id: 'u', givenName: 'A', surname: 'B', jobTitle: 'X', accountEnabled: true });
    const c = mapUser({ id: 'u', givenName: 'A', surname: 'B', jobTitle: 'Y' });
    expect(a.sha256.equals(b.sha256)).toBe(true);
    expect(a.sha256.equals(c.sha256)).toBe(false);
  });
});

describe('subscriptions as licences', () => {
  it('names the common ones the way people know them', () => {
    expect(mapSku({ skuId: 's', skuPartNumber: 'SPB', prepaidUnits: { enabled: 25 }, consumedUnits: 22 })).toEqual({
      skuId: 's', name: 'Microsoft 365 Business Premium', seatsPurchased: 25, seatsUsed: 22,
    });
    expect(mapSku({ skuId: 't', skuPartNumber: 'SOME_NEW_THING', prepaidUnits: { enabled: 3 } })?.name)
      .toBe('SOME NEW THING');
  });

  it('leaves out free, viral and seatless ones', () => {
    expect(mapSku({ skuId: 'a', skuPartNumber: 'FLOW_FREE', prepaidUnits: { enabled: 10000 } })).toBeNull();
    expect(mapSku({ skuId: 'b', skuPartNumber: 'POWERAPPS_VIRAL', prepaidUnits: { enabled: 10000 } })).toBeNull();
    expect(mapSku({ skuId: 'c', skuPartNumber: 'SPB', prepaidUnits: { enabled: 0 }, capabilityStatus: 'Suspended' })).toBeNull();
    expect(mapSku({ skuId: 'd', skuPartNumber: 'UNKNOWN_FREEBIE', prepaidUnits: { enabled: 1_000_000 } })).toBeNull();
  });
});

describe('domains', () => {
  it('imports verified domains other than the tenant’s own onmicrosoft one', () => {
    expect(domainsToImport([
      { id: 'Acme.test', isVerified: true, isDefault: true },
      { id: 'acme.onmicrosoft.com', isVerified: true, isInitial: true },
      { id: 'acme.mail.onmicrosoft.com', isVerified: true },
      { id: 'pending.test', isVerified: false },
    ])).toEqual(['acme.test']);
  });
});

describe('the rest of a person (1060)', () => {
  it('takes aliases from smtp: proxy addresses, not the primary, routing or non-mail ones', () => {
    expect(aliasesOf({
      id: 'u', mail: 'Grace@Acme.test',
      proxyAddresses: ['SMTP:grace@acme.test', 'smtp:G.Hopper@acme.test', 'smtp:gh@acme.test', 'smtp:gh@acme.test',
        'smtp:grace@acme.onmicrosoft.com', 'SIP:grace@acme.test', 'X500:/o=ExchangeLabs'],
    })).toEqual(['g.hopper@acme.test', 'gh@acme.test']);
  });

  it('calls groups what the admin center calls them', () => {
    expect(groupKind({ id: '1', groupTypes: ['Unified'], mailEnabled: true, securityEnabled: false })).toBe('Microsoft 365');
    expect(groupKind({ id: '2', groupTypes: [], mailEnabled: true, securityEnabled: true })).toBe('Mail-enabled security');
    expect(groupKind({ id: '3', groupTypes: [], mailEnabled: false, securityEnabled: true })).toBe('Security');
    expect(groupKind({ id: '4', groupTypes: [], mailEnabled: true, securityEnabled: false })).toBe('Distribution list');
  });

  it('leaves out what Microsoft 365 does not have, and groups it could not read', () => {
    expect(mapProfile({ id: 'u', city: 'Buffalo', country: 'United States', businessPhones: [' '] }, null)).toEqual({
      address: 'Buffalo, United States',
    });
    expect(mapProfile({ id: 'u' }, [{ name: 'Zeta', kind: 'Security' }, { name: 'Alpha', kind: 'Security' }]).groups)
      .toEqual([{ name: 'Alpha', kind: 'Security' }, { name: 'Zeta', kind: 'Security' }]);
    expect(mapProfile({ id: 'u' }, [])).toEqual({ groups: [] });
  });
});
