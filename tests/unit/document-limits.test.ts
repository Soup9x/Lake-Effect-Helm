/**
 * What may be uploaded, and what a browser is allowed to do with it afterwards.
 *
 * The block list is the weaker of the two controls and is tested as such: it
 * stops an .exe called .exe, and it is trivially defeated by a rename. The
 * assertions that matter are the ones about what comes back OUT — no stored
 * file is ever served with a type that invites a browser to run it.
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_EXTENSIONS,
  DEFAULT_MAX_BYTES,
  baseName,
  checkUpload,
  describeBytes,
  extensionOf,
  maxUploadBytes,
  safeContentType,
} from '../../src/lib/documents/limits';

const ok = (filename: string, byteSize = 1024) => checkUpload({ filename, byteSize });

describe('the size cap', () => {
  it('is 50 MB unless the deployment says otherwise', () => {
    expect(maxUploadBytes(undefined)).toBe(DEFAULT_MAX_BYTES);
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it('is configurable, which is the point of the variable', () => {
    expect(maxUploadBytes('200000000')).toBe(200_000_000);
    expect(maxUploadBytes(' 1048576 ')).toBe(1024 * 1024);
  });

  it('falls back rather than disabling itself on junk', () => {
    // A fat-fingered value must not become "no limit". Every one of these is a
    // plausible typo in a compose file.
    for (const junk of ['', '   ', 'fifty', '50MB', '0', '-1', '1.5', 'NaN', 'Infinity']) {
      expect(maxUploadBytes(junk)).toBe(DEFAULT_MAX_BYTES);
    }
  });

  it('refuses a file over the cap, and says what the cap is', () => {
    const result = checkUpload({ filename: 'big.iso', byteSize: 60 * 1024 * 1024 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.code).toBe('file_too_large');
    expect(result.ok === false && result.refusal.message).toContain('HELM_DOCUMENT_MAX_BYTES');
  });

  it('accepts a file exactly at the cap', () => {
    expect(checkUpload({ filename: 'exact.bin', byteSize: 100, maxBytes: 100 }).ok).toBe(true);
  });

  it('refuses an empty file', () => {
    const result = checkUpload({ filename: 'nothing.txt', byteSize: 0 });
    expect(result.ok === false && result.refusal.code).toBe('file_empty');
  });
});

describe('the block list', () => {
  it('refuses executables and installers', () => {
    for (const name of ['setup.exe', 'thing.MSI', 'x.dll', 'shortcut.lnk', 'patch.reg']) {
      const result = ok(name);
      expect(result.ok, name).toBe(false);
      expect(result.ok === false && result.refusal.code).toBe('file_type_blocked');
    }
  });

  it('refuses scripts, and says where a runbook should go instead', () => {
    const result = ok('rebuild-dc.ps1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.message).toMatch(/note|\.txt/);
    for (const name of ['deploy.sh', 'fix.bat', 'run.py', 'x.vbs']) {
      expect(ok(name).ok, name).toBe(false);
    }
  });

  it('is permissive about everything an MSP actually stores', () => {
    for (const name of [
      'acme-network-2026.vsdx',
      'capture.pcap',
      'firmware-2.4.11.bin',
      'switch-config.txt',
      'rack-photo.jpeg',
      'msa-signed.pdf',
      'inventory.csv',
      'backup.iso',
      'certs.pfx',
      'logs.zip',
      'README',
    ]) {
      expect(ok(name).ok, name).toBe(true);
    }
  });

  it('looks at the LAST extension, so a double extension does not smuggle one through', () => {
    expect(ok('invoice.pdf.exe').ok).toBe(false);
    expect(extensionOf('invoice.pdf.exe')).toBe('exe');
    // ...and the reverse is fine: a script saved as text is the documented way
    // to store one.
    expect(ok('rebuild-dc.ps1.txt').ok).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(ok('SETUP.EXE').ok).toBe(false);
    expect(BLOCKED_EXTENSIONS.has('exe')).toBe(true);
  });
});

describe('the filename', () => {
  it('is reduced to a name, whichever separator the client sent', () => {
    expect(baseName('C:\\Users\\tech\\Desktop\\diagram.vsdx')).toBe('diagram.vsdx');
    expect(baseName('/home/tech/diagram.vsdx')).toBe('diagram.vsdx');
    // Not merely cosmetic: the whole Windows path would otherwise become the
    // title in search and the key in a unique index.
    const result = ok('C:\\Users\\tech\\diagram.vsdx');
    expect(result.ok && result.filename).toBe('diagram.vsdx');
  });

  it('refuses names that are not names', () => {
    expect(ok('').ok).toBe(false);
    expect(ok('   ').ok).toBe(false);
    expect(ok('.').ok).toBe(false);
    expect(ok('..').ok).toBe(false);
    expect(ok('/').ok).toBe(false);
  });

  it('refuses control characters, which render as nothing', () => {
    const result = ok('quiet\u0000name.pdf');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.code).toBe('filename_invalid');
  });

  it('bounds the length', () => {
    expect(ok(`${'a'.repeat(201)}.pdf`).ok).toBe(false);
    expect(ok(`${'a'.repeat(190)}.pdf`).ok).toBe(true);
  });
});

describe('what a browser is told the bytes are', () => {
  it('passes through the few types that cannot execute', () => {
    for (const type of ['application/pdf', 'text/plain', 'image/png', 'image/jpeg']) {
      expect(safeContentType(type)).toBe(type);
    }
  });

  it('neutralises everything else', () => {
    for (const type of ['text/html', 'application/javascript', 'application/xhtml+xml']) {
      expect(safeContentType(type)).toBe('application/octet-stream');
    }
  });

  it('never serves SVG as SVG', () => {
    // The one image type that executes script. Served inline it would be stored
    // XSS on Helm's own origin, where the session cookie is.
    expect(safeContentType('image/svg+xml')).toBe('application/octet-stream');
  });
});

describe('describeBytes', () => {
  it('reads like a file listing', () => {
    expect(describeBytes(900)).toBe('900 B');
    expect(describeBytes(1536)).toBe('1.5 KB');
    expect(describeBytes(52428800)).toBe('50.0 MB');
  });
});
