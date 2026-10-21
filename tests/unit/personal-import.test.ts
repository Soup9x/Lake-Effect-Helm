/**
 * Reading other password managers' exports (src/lib/personal/import.ts).
 * One real-shaped sample per format: the columns are found by name, so what
 * matters is that each exporter's own header words are recognised.
 */
import { describe, expect, it } from 'vitest';
import { ImportFormatError, parseCsv, parseVaultImport } from '../../src/lib/personal/import';

describe('CSV exports', () => {
  it('reads Bitwarden, logins only, with the one-time code', () => {
    const parsed = parseVaultImport([
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      'Banking,1,login,My bank,"line one\nline two",,0,https://bank.example,me@example.test,"pa,ss""word",JBSWY3DPEHPK3PXP',
      ',,note,A secure note,secret stuff,,0,,,,',
    ].join('\n'));
    expect(parsed.format).toBe('Bitwarden CSV');
    expect(parsed.skipped).toBe(1);
    expect(parsed.entries).toEqual([{
      name: 'My bank', url: 'https://bank.example', username: 'me@example.test',
      password: 'pa,ss"word', totp: 'JBSWY3DPEHPK3PXP', notes: 'line one\nline two',
    }]);
  });

  it('reads Chrome and Edge', () => {
    const parsed = parseVaultImport('name,url,username,password,note\r\nexample.com,https://example.com/login,alice,hunter2,\r\n');
    expect(parsed.entries).toEqual([expect.objectContaining({
      name: 'example.com', url: 'https://example.com/login', username: 'alice', password: 'hunter2', notes: null,
    })]);
  });

  it('reads Firefox, naming each entry after its site', () => {
    const parsed = parseVaultImport([
      '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"',
      '"https://www.mozilla.org","bob","pw1","","https://www.mozilla.org","{1}","1","1","1"',
    ].join('\n'));
    expect(parsed.format).toBe('Firefox CSV');
    expect(parsed.entries[0]).toMatchObject({ name: 'mozilla.org', username: 'bob', password: 'pw1' });
  });

  it('reads 1Password, LastPass and KeePass', () => {
    expect(parseVaultImport('Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nRouter,http://10.0.0.1,admin,pw,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP,false,false,,n')
      .entries[0]).toMatchObject({ name: 'Router', totp: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', notes: 'n' });
    expect(parseVaultImport('url,username,password,totp,extra,name,grouping,fav\nhttps://a.test,u,p,,note,Site A,Work,0')
      .entries[0]).toMatchObject({ name: 'Site A', url: 'https://a.test', notes: 'note' });
    expect(parseVaultImport('"Group","Title","Username","Password","URL","Notes"\n"Root","NAS","root","pw","https://nas.local",""')
      .entries[0]).toMatchObject({ name: 'NAS', url: 'https://nas.local', username: 'root' });
  });

  it('reads a semicolon-separated export', () => {
    expect(parseCsv('name;username;password\nA;b;c')).toEqual([['name', 'username', 'password'], ['A', 'b', 'c']]);
  });

  it('skips rows with nothing to keep, and refuses a file that is not an export', () => {
    expect(parseVaultImport('name,url,username,password\n,,,\n,,,\nx,,,').entries).toHaveLength(1);
    expect(() => parseVaultImport('first,second\n1,2')).toThrow(ImportFormatError);
    expect(() => parseVaultImport('name,password\n"unterminated,x')).toThrow(/cut short/);
  });
});

describe('Bitwarden JSON', () => {
  it('reads logins and leaves the rest out', () => {
    const parsed = parseVaultImport(JSON.stringify({
      encrypted: false,
      items: [
        { type: 1, name: 'GitHub', notes: null, login: { username: 'octo', password: 'pw', totp: null, uris: [{ uri: 'https://github.com' }] } },
        { type: 3, name: 'Visa' },
        { type: 2, name: 'Note', notes: 'x' },
      ],
    }));
    expect(parsed).toEqual({
      format: 'Bitwarden JSON',
      skipped: 2,
      entries: [{ name: 'GitHub', username: 'octo', url: 'https://github.com', password: 'pw', totp: null, notes: null }],
    });
  });

  it('refuses an encrypted export with a sentence saying how to get a readable one', () => {
    expect(() => parseVaultImport('{"encrypted": true, "data": "2.abc"}')).toThrow(/encrypted Bitwarden export/);
  });
});
