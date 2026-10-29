/**
 * Which registry values count as a difference a person has to verify (1140).
 */
import { describe, expect, it } from 'vitest';
import { needsReview, registrySuggestions } from '../../src/lib/external/registry-suggestions';

const byKey = (list: ReturnType<typeof registrySuggestions>) =>
  Object.fromEntries(list.map((s) => [s.key, s.state]));

describe('registry suggestions', () => {
  it('sorts each field into matches, fill and differs', () => {
    const list = registrySuggestions(
      {
        registrar: 'godaddy.com,  llc', registered_at: null, expires_at: '2027-05-01',
        nameservers: ['NS2.example.com', 'ns1.example.com.'], transfer_locked: null, dnssec_enabled: false,
      },
      {
        registrar: 'GoDaddy.com, LLC', registered_at: '2019-05-04', expires_at: '2027-05-04',
        nameservers: ['ns1.example.com', 'ns2.example.com'], transfer_locked: true, dnssec_enabled: false,
      },
      null,
    );
    expect(byKey(list)).toEqual({
      registrar: 'matches',
      registered_at: 'fill',
      expires_at: 'differs',
      nameservers: 'matches',
      transfer_locked: 'fill',
      dnssec_enabled: 'matches',
    });
    expect(list.filter(needsReview).map((s) => s.key)).toEqual(['registered_at', 'expires_at', 'transfer_locked']);
  });

  it('leaves out a field the registry said nothing about', () => {
    expect(registrySuggestions({ registrar: 'Mine' }, { nameservers: ['ns1.x.test'] }, null).map((s) => s.key))
      .toEqual(['nameservers']);
    expect(registrySuggestions({}, null, null)).toEqual([]);
  });

  it('stays quiet about a value somebody kept, until the registry says something new', () => {
    const recorded = { expires_at: '2027-05-01' };
    const kept = { expires_at: '2027-05-04' };
    expect(byKey(registrySuggestions(recorded, { expires_at: '2027-05-04' }, kept)).expires_at).toBe('kept');
    expect(byKey(registrySuggestions(recorded, { expires_at: '2028-05-04' }, kept)).expires_at).toBe('differs');
  });
});
