/**
 * Reading password managers' exports for a client's Credentials
 * (src/lib/import/password-export.ts). One real-shaped sample per format: what
 * matters is that each exporter's own column words and JSON nesting arrive in
 * the right field, and that what is left out is counted rather than lost.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  distinctValues,
  mapPasswordRows,
  PasswordExportError,
  readPasswordFile,
  readPasswordText,
  suggestMapping,
} from '../../src/lib/import/password-export';

const mapped = (text: string) => {
  const table = readPasswordText(text);
  return { table, rows: mapPasswordRows(table, table.suggested) };
};

describe('CSV exports', () => {
  it('reads Bitwarden, leaving out what is not a login', () => {
    const { table, rows } = mapped([
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      'Acme,1,login,Acme firewall,"line one\nline two",,0,https://fw.acme.test,admin," pa,ss""word",JBSWY3DPEHPK3PXP',
      ',,note,A secure note,secret stuff,,0,,,,',
    ].join('\n'));
    expect(table.format).toBe('Bitwarden CSV');
    expect(table.skipped).toBe(1);
    expect(rows).toEqual([{
      name: 'Acme firewall', username: 'admin', password: ' pa,ss"word', url: 'https://fw.acme.test',
      totpSeed: 'JBSWY3DPEHPK3PXP', notes: 'line one\nline two', folder: 'Acme',
    }]);
  });

  it('reads LastPass, dropping secure notes and keeping the group as a folder', () => {
    const { table, rows } = mapped([
      'url,username,password,totp,extra,name,grouping,fav',
      'https://portal.acme.test,jo,pw,,a note,Portal,Clients\\Acme,0',
      'http://sn,,,,NoteType:Server,Server note,Clients\\Acme,0',
    ].join('\n'));
    expect(table.format).toBe('LastPass CSV');
    expect(table.skipped).toBe(1);
    expect(rows[0]).toMatchObject({ name: 'Portal', notes: 'a note', folder: 'Clients\\Acme' });
  });

  it('reads 1Password, Chrome, Dashlane and IT Glue headers', () => {
    expect(mapped('Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nRouter,http://10.0.0.1,admin,pw,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP,false,false,,n')
      .rows[0]).toMatchObject({ name: 'Router', totpSeed: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', notes: 'n' });
    expect(mapped('name,url,username,password,note\nexample.com,https://example.com,alice,hunter2,hi')
      .rows[0]).toMatchObject({ name: 'example.com', notes: 'hi' });
    expect(mapped('username,username2,username3,title,password,note,url,category,otpSecret\nu,,,Mail,pw,,https://m.test,Business,')
      .table.format).toBe('Dashlane CSV');
    expect(mapped('id,organization,name,password_category,username,password,url,notes,otp_secret\n1,Acme,DC admin,Windows,acme\\admin,pw,,,')
      .rows[0]).toMatchObject({ name: 'DC admin', username: 'acme\\admin', folder: 'Windows' });
  });

  it('names a Firefox entry after its site', () => {
    const { rows } = mapped([
      '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"',
      '"https://www.mozilla.org","bob","pw1","","https://www.mozilla.org","{1}","1","1","1"',
    ].join('\n'));
    expect(rows[0]).toMatchObject({ name: 'mozilla.org', username: 'bob', password: 'pw1' });
  });

  it('treats Keeper\'s header-less CSV as data, in Keeper\'s column order', () => {
    const { table, rows } = mapped('Acme,Firewall,admin,pw,https://fw.acme.test,closet,,\nAcme,Wi-Fi,,pw2,,,,');
    expect(table.format).toBe('Keeper CSV');
    expect(table.headerless).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ folder: 'Acme', name: 'Firewall', username: 'admin', password: 'pw', url: 'https://fw.acme.test', notes: 'closet' });
  });

  it('can be told the first row is data', () => {
    const table = readPasswordText('Router,admin,pw\nSwitch,admin,pw2', { headerless: true });
    expect(table.columns).toEqual(['Column 1', 'Column 2', 'Column 3']);
    expect(table.rows).toHaveLength(2);
  });

  it('suggests each column to at most one field', () => {
    // `login` and `username` both mean username. The better word wins, and the
    // other column is left unmapped rather than given to some other field.
    const mapping = suggestMapping(['Name', 'Login', 'Username', 'Password']);
    expect(mapping).toMatchObject({ name: 0, username: 2, password: 3 });
    expect(Object.values(mapping)).not.toContain(1);
  });
});

describe('JSON exports', () => {
  it('reads Bitwarden, with folder names and without custom fields', () => {
    const { table, rows } = mapped(JSON.stringify({
      encrypted: false,
      folders: [{ id: 'f1', name: 'Acme' }],
      items: [
        { type: 1, name: 'M365 admin', folderId: 'f1', notes: null,
          fields: [{ name: 'PIN', value: '1234', type: 1 }],
          login: { username: 'admin@acme.test', password: 'pw', totp: 'JBSWY3DPEHPK3PXP',
            uris: [{ uri: '' }, { uri: 'https://admin.microsoft.com' }] } },
        { type: 2, name: 'A note', notes: 'x' },
      ],
    }));
    expect(table.format).toBe('Bitwarden JSON');
    expect(table.skipped).toBe(1);
    expect(table.notices[0]).toMatch(/1 custom field was left out/);
    expect(rows).toEqual([{
      name: 'M365 admin', username: 'admin@acme.test', password: 'pw', url: 'https://admin.microsoft.com',
      totpSeed: 'JBSWY3DPEHPK3PXP', notes: '', folder: 'Acme',
    }]);
  });

  it('uses a Bitwarden organization export\'s collection as the folder', () => {
    const { table, rows } = mapped(JSON.stringify({
      collections: [{ id: 'c1', name: 'Clients/Acme' }],
      items: [{ type: 1, name: 'NAS', collectionIds: ['c1'], login: { username: 'root', password: 'pw' } }],
    }));
    expect(table.format).toBe('Bitwarden organization JSON');
    expect(rows[0]!.folder).toBe('Clients/Acme');
  });

  it('refuses an encrypted export with a way forward', () => {
    expect(() => readPasswordText('{"encrypted":true,"data":"2.abc"}')).toThrow(/unencrypted JSON/);
  });

  it('reads Keeper, finding the one-time code among custom fields', () => {
    const { table, rows } = mapped(JSON.stringify({
      records: [
        { title: 'Firewall', login: 'admin', password: 'pw', login_url: 'https://fw', notes: 'n',
          custom_fields: { 'TFC:Keeper': 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', 'Serial': 'ABC' },
          folders: [{ shared_folder: 'Acme' }] },
        { $type: 'bankCard', title: 'Card' },
      ],
    }));
    expect(table.format).toBe('Keeper JSON');
    expect(table.skipped).toBe(1);
    expect(table.notices).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Firewall', totpSeed: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', folder: 'Acme' });
  });

  it('reads Proton Pass', () => {
    const { rows, table } = mapped(JSON.stringify({
      encrypted: false,
      vaults: { v1: { name: 'Acme', items: [
        { data: { type: 'login', metadata: { name: 'VPN', note: '' },
          content: { itemEmail: 'it@acme.test', itemUsername: '', password: 'pw', urls: ['https://vpn'], totpUri: '' } } },
        { data: { type: 'note', metadata: { name: 'x' }, content: {} } },
      ] } },
    }));
    expect(table.skipped).toBe(1);
    expect(rows[0]).toMatchObject({ name: 'VPN', username: 'it@acme.test', folder: 'Acme' });
  });

  it('reads 1Password\'s export.data, keeping logins and the vault as folder', () => {
    const { rows, table } = mapped(JSON.stringify({
      accounts: [{ vaults: [{ attrs: { name: 'Acme' }, items: [
        { categoryUuid: '001', state: 'active', overview: { title: 'Router', url: 'http://10.0.0.1' },
          details: { notesPlain: 'closet',
            loginFields: [{ designation: 'username', value: 'admin' }, { designation: 'password', value: 'pw' }],
            sections: [{ fields: [{ title: 'one-time', value: { totp: 'otpauth://totp/r?secret=JBSWY3DPEHPK3PXP' } }] }] } },
        { categoryUuid: '001', state: 'archived', overview: { title: 'Old' }, details: {} },
        { categoryUuid: '003', overview: { title: 'Secure note' }, details: {} },
      ] }] }],
    }));
    expect(table.format).toBe('1Password 1PUX');
    expect(table.skipped).toBe(2);
    expect(rows).toEqual([{
      name: 'Router', username: 'admin', password: 'pw', url: 'http://10.0.0.1',
      totpSeed: 'otpauth://totp/r?secret=JBSWY3DPEHPK3PXP', notes: 'closet', folder: 'Acme',
    }]);
  });

  it('turns a list of flat objects into columns to map', () => {
    const table = readPasswordText(JSON.stringify([
      { Account: 'Router', Login: 'admin', Pass: 'pw', extra: { nested: true } },
    ]));
    expect(table.format).toBe('JSON');
    expect(table.columns).toEqual(['Account', 'Login', 'Pass']);
    expect(mapPasswordRows(table, table.suggested)[0]).toMatchObject({ name: 'Router', username: 'admin', password: 'pw' });
  });

  it('refuses JSON it does not know', () => {
    expect(() => readPasswordText('{"hello":"world"}')).toThrow(PasswordExportError);
    expect(() => readPasswordText('{not json')).toThrow(/not valid JSON/);
  });
});

/** A zip of deflated files, the shape .1pux, Dashlane's and IT Glue's exports have. */
function zip(...files: [string, string][]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = deflateRawSync(Buffer.from(content));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, end]));
}

describe('zip exports', () => {
  it('unpacks a .1pux', async () => {
    const table = await readPasswordFile(zip(['export.data', JSON.stringify({
      accounts: [{ vaults: [{ attrs: { name: 'V' }, items: [
        { categoryUuid: '005', overview: { title: 'Wi-Fi' }, details: { password: 'pw' } },
      ] }] }],
    })]));
    expect(table.format).toBe('1Password 1PUX');
    expect(mapPasswordRows(table, table.suggested)[0]).toMatchObject({ name: 'Wi-Fi', password: 'pw' });
  });

  it('unpacks a zip holding one CSV', async () => {
    const table = await readPasswordFile(zip(['credentials.csv', 'title,username,password\nMail,u,pw']));
    expect(table.rows).toEqual([['Mail', 'u', 'pw']]);
  });

  it('finds passwords.csv in an IT Glue export among its other CSVs', async () => {
    const table = await readPasswordFile(zip(
      ['organizations.csv', 'id,name\n1,Acme'],
      ['passwords.csv', 'organization,name,username,password\nAcme,DC,admin,pw'],
      ['configurations.csv', 'id,name\n1,DC01'],
    ));
    expect(table.rows).toEqual([['Acme', 'DC', 'admin', 'pw']]);
  });

  it('reads plain bytes as text', async () => {
    const table = await readPasswordFile(new TextEncoder().encode('name,password\nA,b'));
    expect(table.rows).toHaveLength(1);
  });
});

describe('mapping and filtering', () => {
  const table = readPasswordText([
    'organization,name,username,password,url',
    'Acme,Firewall,admin,pw,"https://a.test, https://b.test"',
    'Globex,Router,admin,pw2,',
    ',,,,',
  ].join('\n'));

  it('keeps only the rows a filter names, and drops blank ones', () => {
    expect(mapPasswordRows(table, table.suggested, { column: 0, value: 'Acme' })).toHaveLength(1);
    expect(mapPasswordRows(table, table.suggested)).toHaveLength(2);
  });

  it('keeps the first of several URLs', () => {
    expect(mapPasswordRows(table, table.suggested)[0]!.url).toBe('https://a.test');
  });

  it('lists a column\'s values for the filter', () => {
    expect(distinctValues(table, 0)).toEqual(['Acme', 'Globex']);
  });

  it('follows a corrected mapping', () => {
    const rows = mapPasswordRows(table, { ...table.suggested, folder: 0 });
    expect(rows[1]).toMatchObject({ name: 'Router', folder: 'Globex' });
  });
});
