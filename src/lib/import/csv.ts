/**
 * CSV, to RFC 4180.
 *
 * WRITTEN HERE RATHER THAN PULLED IN, for the same reason src/lib/crypto/totp.ts
 * is: this parser sits between an uploaded file and the vault, and on the
 * password path the cells it produces are plaintext credentials. Every
 * dependency in that position is supply-chain surface on the most sensitive
 * input the product accepts. The grammar is eighty lines and is fully specified.
 *
 * WHAT IT HANDLES, because real exports contain all of it:
 *
 *   "Smith, John"            a comma inside a quoted field
 *   "he said ""no"""         a doubled quote meaning one literal quote
 *   "line one\nline two"     a newline inside a quoted field — LastPass does
 *                            this for multi-line notes, and a line-splitting
 *                            parser silently truncates the record
 *   \r\n, \r, \n             any of the three line endings, mixed
 *   a trailing newline       which is not an empty final row
 *   a UTF-8 BOM              which Excel writes and which otherwise becomes
 *                            part of the first header's name
 *
 * WHAT IT DOES NOT DO: guess the delimiter, or coerce types. A semicolon-
 * separated file from a European Excel is rejected by the header check rather
 * than parsed into one enormous column, which is the more useful failure.
 */

export interface CsvParseError {
  /** 1-based, counting the header. */
  line: number;
  message: string;
}

export interface ParsedCsv {
  headers: string[];
  /** One record per row, keyed by header. Short rows pad, long rows error. */
  rows: Record<string, string>[];
  errors: CsvParseError[];
}

/** The ceiling on an uploaded file. Generous for a client's whole password list. */
export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 5000;

/**
 * Split into fields, tracking quotes. Returns rows of raw strings; header
 * mapping happens above it.
 */
function tokenise(input: string): { rows: string[][]; errors: CsvParseError[] } {
  const rows: string[][] = [];
  const errors: CsvParseError[] = [];

  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  /* Whether anything at all has been seen on this row, so a trailing newline
   * does not manufacture a final empty record. */
  let rowStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A row of one empty field is a blank line, not a record.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    rowStarted = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"') {
      // A quote only opens a field at its start. Mid-field it is literal —
      // `3" riser` is a product name, not a parse error.
      if (field === '') inQuotes = true;
      else field += char;
      rowStarted = true;
      continue;
    }

    if (char === ',') {
      endField();
      rowStarted = true;
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      if (rowStarted || field !== '' || row.length > 0) endRow();
      line += 1;
      continue;
    }

    field += char;
    rowStarted = true;
  }

  if (inQuotes) {
    errors.push({ line, message: 'the file ends inside a quoted value — a quote is unclosed' });
  }
  if (rowStarted || field !== '' || row.length > 0) endRow();

  return { rows, errors };
}

export function parseCsv(input: string): ParsedCsv {
  // Excel writes a BOM. Left in place it becomes part of the first header's
  // name, and every lookup of that column misses by one invisible character.
  const text = input.replace(/^﻿/, '');
  const { rows: raw, errors } = tokenise(text);

  if (raw.length === 0) {
    return { headers: [], rows: [], errors: [{ line: 1, message: 'the file is empty' }] };
  }

  const headers = raw[0]!.map((h) => h.trim());
  if (headers.every((h) => h === '')) {
    return { headers: [], rows: [], errors: [{ line: 1, message: 'the first row has no column names' }] };
  }
  const duplicate = headers.find((h, i) => h !== '' && headers.indexOf(h) !== i);
  if (duplicate) {
    errors.push({ line: 1, message: `two columns are both called "${duplicate}"` });
  }

  const rows: Record<string, string>[] = [];
  for (let r = 1; r < raw.length; r += 1) {
    const cells = raw[r]!;
    const line = r + 1;

    if (cells.length > headers.length) {
      errors.push({
        line,
        message: `this row has ${cells.length} values but there are ${headers.length} columns`,
      });
      continue;
    }

    const record: Record<string, string> = {};
    headers.forEach((header, c) => {
      if (header === '') return;
      // Short rows pad rather than erroring: a trailing empty column is the
      // single most common shape of a hand-edited export.
      record[header] = (cells[c] ?? '').trim();
    });
    rows.push(record);

    if (rows.length >= CSV_MAX_ROWS) {
      errors.push({
        line,
        message: `only the first ${CSV_MAX_ROWS} rows are imported in one go`,
      });
      break;
    }
  }

  return { headers: headers.filter((h) => h !== ''), rows, errors };
}
