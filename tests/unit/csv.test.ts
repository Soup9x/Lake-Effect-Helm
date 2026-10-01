import { describe, expect, it } from 'vitest';
import { parseCsv, CSV_MAX_ROWS } from '../../src/lib/import/csv';

/**
 * The shapes real exports actually arrive in.
 *
 * Every case here is something a technician has genuinely uploaded: a comma in a
 * company name, a multi-line note from LastPass, a BOM from Excel, a hand-edited
 * row with a trailing comma. A parser that splits on commas and newlines handles
 * none of them, and fails SILENTLY — producing plausible rows with the wrong
 * values, which is how a password ends up filed under the wrong client.
 */
describe('the ordinary cases', () => {
  it('reads a header and its rows', () => {
    const { headers, rows, errors } = parseCsv('name,username\nRouter,admin\nSwitch,root\n');
    expect(headers).toEqual(['name', 'username']);
    expect(rows).toEqual([
      { name: 'Router', username: 'admin' },
      { name: 'Switch', username: 'root' },
    ]);
    expect(errors).toEqual([]);
  });

  it('does not invent a row from the trailing newline', () => {
    expect(parseCsv('a\n1\n').rows).toHaveLength(1);
    expect(parseCsv('a\n1').rows).toHaveLength(1);
  });

  it('skips blank lines in the middle', () => {
    expect(parseCsv('a\n1\n\n2\n').rows).toEqual([{ a: '1' }, { a: '2' }]);
  });

  it('accepts all three line endings, mixed', () => {
    expect(parseCsv('a,b\r\n1,2\r3,4\n5,6').rows).toEqual([
      { a: '1', b: '2' }, { a: '3', b: '4' }, { a: '5', b: '6' },
    ]);
  });
});

describe('quoting', () => {
  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('name,city\n"Smith, John",Holland\n').rows).toEqual([
      { name: 'Smith, John', city: 'Holland' },
    ]);
  });

  it('turns a doubled quote into one literal quote', () => {
    expect(parseCsv('note\n"he said ""no"""\n').rows).toEqual([{ note: 'he said "no"' }]);
  });

  /*
   * The one that matters most. LastPass writes multi-line notes, and a parser
   * that splits the file on newlines before parsing quotes truncates the record
   * and shifts every subsequent column.
   */
  it('keeps a newline inside a quoted field', () => {
    const { rows, errors } = parseCsv('name,note\nRouter,"line one\nline two"\nSwitch,plain\n');
    expect(rows).toEqual([
      { name: 'Router', note: 'line one\nline two' },
      { name: 'Switch', note: 'plain' },
    ]);
    expect(errors).toEqual([]);
  });

  it('treats a quote in the middle of a field as a literal', () => {
    // `3" riser` is a product name, not a parse error.
    expect(parseCsv('name\n3" riser\n').rows).toEqual([{ name: '3" riser' }]);
  });

  it('reports an unclosed quote rather than swallowing the rest of the file', () => {
    const { errors } = parseCsv('a\n"never closed\n');
    expect(errors.some((e) => /unclosed/.test(e.message))).toBe(true);
  });
});

describe('the things Excel does', () => {
  it('strips a UTF-8 BOM off the first header', () => {
    const { headers, rows } = parseCsv('﻿name,city\nRouter,Holland\n');
    expect(headers).toEqual(['name', 'city']);
    // The lookup that would have missed by one invisible character.
    expect(rows[0]!.name).toBe('Router');
  });

  it('trims whitespace around headers and values', () => {
    expect(parseCsv(' name , city \n Router , Holland \n').rows).toEqual([
      { name: 'Router', city: 'Holland' },
    ]);
  });
});

describe('rows that do not fit', () => {
  it('pads a short row rather than rejecting it', () => {
    expect(parseCsv('a,b,c\n1,2\n').rows).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('refuses a row with more values than columns', () => {
    const { rows, errors } = parseCsv('a,b\n1,2,3\n4,5\n');
    expect(rows).toEqual([{ a: '4', b: '5' }]);
    expect(errors[0]).toMatchObject({ line: 2 });
    expect(errors[0]!.message).toMatch(/3 values but there are 2 columns/);
  });

  it('names the line a problem is on, counting the header as line 1', () => {
    const { errors } = parseCsv('a,b\n1,2\n3,4,5\n');
    expect(errors[0]!.line).toBe(3);
  });

  it('refuses two columns with the same name', () => {
    const { errors } = parseCsv('name,name\n1,2\n');
    expect(errors.some((e) => /both called "name"/.test(e.message))).toBe(true);
  });

  it('stops at the row ceiling and says so', () => {
    const body = Array.from({ length: CSV_MAX_ROWS + 50 }, (_, i) => `row${i}`).join('\n');
    const { rows, errors } = parseCsv(`a\n${body}\n`);
    expect(rows).toHaveLength(CSV_MAX_ROWS);
    expect(errors.some((e) => /only the first/.test(e.message))).toBe(true);
  });
});

describe('files that are not usable at all', () => {
  it('rejects an empty file', () => {
    expect(parseCsv('').errors[0]!.message).toMatch(/empty/);
  });

  it('rejects a header row with no names', () => {
    expect(parseCsv(',,\n1,2,3\n').errors[0]!.message).toMatch(/no column names/);
  });

  /*
   * A semicolon-separated export from a European Excel parses as one enormous
   * column. That is caught by the column check at the layer above — here it just
   * has to not pretend it worked.
   */
  it('does not guess the delimiter', () => {
    const { headers } = parseCsv('name;city\nRouter;Holland\n');
    expect(headers).toEqual(['name;city']);
  });
});
