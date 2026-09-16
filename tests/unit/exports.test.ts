/**
 * The two pieces of the export engine written in-tree: the PDF writer and the
 * bundle format.
 *
 * Both exist instead of a dependency, so both owe a demonstration that they
 * actually work — a PDF that no reader opens and an archive that cannot be
 * unpacked are worse than the libraries they replaced.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PdfDocument, encodePdfText, textWidth } from '../../src/lib/exports/pdf';
import {
  generatePassphrase,
  isEncryptedBundle,
  packBundle,
  unpackBundle,
} from '../../src/lib/exports/bundle';

const cover = { title: 'Acme — Offboarding', footer: 'CONFIDENTIAL' };

describe('PDF writer', () => {
  it('produces a structurally valid file with a resolvable xref table', () => {
    const doc = new PdfDocument(cover);
    doc.heading('Acme Corporation').paragraph('A short handover document.');
    const bytes = doc.render();

    expect(bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(bytes.subarray(-6).toString('latin1').trim()).toBe('%%EOF');

    // Every xref offset must land on its own object header, or readers reject
    // the file — and the failure mode is a handover nobody can open.
    const text = bytes.toString('latin1');
    const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
    const lines = text.slice(startxref).split('\n');
    const count = Number(lines[1]?.split(' ')[1]);

    for (let id = 1; id < count; id += 1) {
      const offset = Number(lines[1 + id + 1]?.slice(0, 10));
      expect(text.slice(offset, offset + 12)).toMatch(new RegExp(`^${id} 0 obj`));
    }
  });

  it('flows onto more pages as content grows', () => {
    const short = new PdfDocument(cover).paragraph('one line').render().toString('latin1');
    const long = new PdfDocument(cover)
      .table(
        [{ header: 'Name', width: 0.5 }, { header: 'Detail', width: 0.5 }],
        Array.from({ length: 200 }, (_, i) => [`host-${i}`, 'Windows Server 2022']),
      )
      .render()
      .toString('latin1');

    const pages = (pdf: string): number => (pdf.match(/\/Type \/Page /g) ?? []).length;
    expect(pages(short)).toBe(1);
    expect(pages(long)).toBeGreaterThan(3);
  });

  it('repeats table headers after a page break', () => {
    const pdf = new PdfDocument(cover)
      .table(
        [{ header: 'Serial', width: 1 }],
        Array.from({ length: 120 }, (_, i) => [`SN-${i}`]),
      )
      .render()
      .toString('latin1');

    expect((pdf.match(/\(SERIAL\)/g) ?? []).length).toBeGreaterThan(1);
  });

  it('escapes the characters that would corrupt a content stream', () => {
    expect(encodePdfText('a(b)c\\d')).toBe('a\\(b\\)c\\\\d');
  });

  it('maps WinAnsi punctuation instead of mangling it', () => {
    // These appear constantly in generated prose. Without the map every one
    // becomes '?', and a handover peppered with question marks reads as broken.
    expect(encodePdfText('—').charCodeAt(0)).toBe(0x97);
    expect(encodePdfText('’').charCodeAt(0)).toBe(0x92);
    expect(encodePdfText('…').charCodeAt(0)).toBe(0x85);
  });

  it('substitutes a visible marker for text it genuinely cannot represent', () => {
    // Visibly wrong beats silently dropped: a dropped character changes a
    // hostname, and the JSON companion carries the text unmangled anyway.
    expect(encodePdfText('中文')).toBe('??');
  });

  it('uses real font metrics, so wrapping does not overflow the margin', () => {
    // 'i' is narrow and 'W' is wide; a naive fixed-width estimate gets this
    // wrong and produces lines that run off the page.
    expect(textWidth('W', 10)).toBeGreaterThan(textWidth('i', 10) * 2);
    expect(textWidth('Hello', 10, 'Helvetica-Bold')).toBeGreaterThan(textWidth('Hello', 10));
  });

  it('breaks a single word that is wider than the line', () => {
    const long = 'a'.repeat(400);
    const pdf = new PdfDocument(cover).paragraph(long).render().toString('latin1');
    // Broken into several Tj operators rather than one run off the page.
    expect((pdf.match(/\(a+\) Tj/g) ?? []).length).toBeGreaterThan(1);
  });

  it('carries a non-ASCII title as a UTF-16 text string, not as content bytes', () => {
    // The /Info dictionary is not subject to the font's WinAnsiEncoding, so the
    // title needs a different encoding from the page content or the reader's
    // title bar shows mojibake.
    const pdf = new PdfDocument(cover).paragraph('x').render().toString('latin1');
    expect(pdf).toMatch(/\/Title <feff/i);
  });
});

describe('bundle format', () => {
  const entries = [
    { name: 'export.json', contentType: 'application/json', bytes: Buffer.from('{"a":1}') },
    { name: 'export.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 fake') },
  ];

  it('round-trips unencrypted', () => {
    const packed = packBundle(entries, false);
    expect(packed.passphrase).toBeNull();
    expect(packed.encryptionMethod).toBeNull();
    expect(isEncryptedBundle(packed.bytes)).toBe(false);

    const unpacked = unpackBundle(packed.bytes);
    expect(unpacked.entries.map((e) => e.name)).toEqual(['export.json', 'export.pdf']);
    expect(unpacked.entries[0]?.bytes.toString()).toBe('{"a":1}');
  });

  it('round-trips encrypted, with the passphrase it generated', () => {
    const packed = packBundle(entries, true);
    expect(packed.passphrase).toMatch(/^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);
    expect(packed.encryptionMethod).toBe('AES-256-GCM/scrypt(N=32768,r=8,p=1)');
    expect(isEncryptedBundle(packed.bytes)).toBe(true);

    const unpacked = unpackBundle(packed.bytes, packed.passphrase!);
    expect(unpacked.entries[1]?.bytes.toString()).toBe('%PDF-1.4 fake');
  });

  it('leaks nothing about its contents when encrypted', () => {
    const secretish = [
      {
        name: 'export.json',
        contentType: 'application/json',
        bytes: Buffer.from('correct-horse-battery'),
      },
    ];
    const packed = packBundle(secretish, true);
    // Not even the manifest — which names the files and their digests — is in
    // the clear, because the whole archive including the manifest is sealed.
    expect(packed.bytes.toString('latin1')).not.toContain('correct-horse-battery');
    expect(packed.bytes.toString('latin1')).not.toContain('export.json');
  });

  it('refuses the wrong passphrase, indistinguishably from tampering', () => {
    const packed = packBundle(entries, true);
    expect(() => unpackBundle(packed.bytes, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA')).toThrow(
      /wrong passphrase, or it was modified/,
    );
  });

  it('refuses a modified ciphertext', () => {
    const packed = packBundle(entries, true);
    const tampered = Buffer.from(packed.bytes);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0x01, tampered.length - 1);

    expect(() => unpackBundle(tampered, packed.passphrase!)).toThrow(
      /wrong passphrase, or it was modified/,
    );
  });

  it('asks for a passphrase rather than returning garbage', () => {
    const packed = packBundle(entries, true);
    expect(() => unpackBundle(packed.bytes)).toThrow(/a passphrase is required/);
  });

  it('detects an entry that does not match its manifest digest', () => {
    // Unencrypted bundles have no AEAD tag, so the per-entry digests are what
    // catches a file edited in transit.
    const packed = packBundle(entries, false);
    const tampered = Buffer.from(packed.bytes);
    const at = tampered.indexOf(Buffer.from('{"a":1}'));
    tampered.writeUInt8(tampered.readUInt8(at) ^ 0x01, at);

    expect(() => unpackBundle(tampered)).toThrow(/does not match its manifest digest/);
  });

  it('refuses something that is not a bundle at all', () => {
    expect(() => unpackBundle(randomBytes(64))).toThrow(/not a Helm bundle/);
  });

  it('digests the sealed bytes, so a recipient can verify without the passphrase', () => {
    const packed = packBundle(entries, true);
    expect(createHash('sha256').update(packed.bytes).digest()).toEqual(packed.sha256);
  });
});

describe('passphrase generation', () => {
  it('uses an alphabet with no visually ambiguous characters', () => {
    // These get transcribed by a human reading one screen and typing into
    // another. 0/O and 1/l/I are where that goes wrong.
    const sample = Array.from({ length: 200 }, () => generatePassphrase()).join('');
    expect(sample).not.toMatch(/[01OIl]/);
  });

  it('is unbiased across the alphabet', () => {
    // Rejection sampling rather than `% 31` on a byte: the naive version makes
    // the first few symbols measurably more likely.
    const counts = new Map<string, number>();
    const sample = Array.from({ length: 4000 }, () => generatePassphrase())
      .join('')
      .replace(/-/g, '');
    for (const ch of sample) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(31);

    const values = [...counts.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // A modulo bias on a 31-symbol alphabet would push the first ten symbols
    // about 3% high; 15% is loose enough not to flake and tight enough to
    // catch a genuinely skewed generator.
    for (const value of values) {
      expect(Math.abs(value - mean) / mean).toBeLessThan(0.15);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassphrase()));
    expect(seen.size).toBe(500);
  });
});
