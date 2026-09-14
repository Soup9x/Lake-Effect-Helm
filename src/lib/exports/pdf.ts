/**
 * A minimal PDF writer.
 *
 * Written in-tree rather than pulled from npm, for the same reason as the TOTP
 * implementation: this code runs inside the process that holds decrypted client
 * credentials, and the PDF renderers on npm are large dependency trees — font
 * parsers, image codecs, sometimes a headless browser — whose transitive
 * surface is far larger than the feature being bought. A compliance handover
 * document is headings, paragraphs and tables in one of the fourteen standard
 * PDF fonts. That is a few hundred lines of a well-specified format, and it is
 * a much smaller thing to audit than a rendering engine.
 *
 * What this supports: multi-page flow, Helvetica regular and bold, headings,
 * paragraphs with word wrap, definition lists, simple tables with column
 * widths, page numbering, and a footer. It does NOT support images, embedded
 * fonts, or non-Latin-1 text — see `encodePdfText`, which is explicit about
 * what it does with characters it cannot represent rather than silently
 * emitting mojibake.
 *
 * Output is uncompressed. A 200-page inventory is a few hundred kilobytes, and
 * uncompressed content streams mean the file can be inspected with `strings`
 * during an incident, which is worth more here than the disk space.
 */

const PAGE_WIDTH = 595.28; // A4 at 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/**
 * Helvetica advance widths, in 1/1000 em, for Latin-1 code points 32..255.
 *
 * Bundled because word wrap without real metrics produces lines that overflow
 * the margin, and a handover document with text running off the page looks like
 * exactly the kind of thing nobody checked. These are the widths from the
 * standard Adobe AFM for Helvetica; Helvetica-Bold differs and has its own row.
 */
const HELVETICA_WIDTHS = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,
  556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,
  722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,
  278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];

const HELVETICA_BOLD_WIDTHS = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,
  556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,
  722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,
  278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,
];

/** Everything outside 32..126 falls back to this. */
const DEFAULT_WIDTH = 556;

export type FontName = 'Helvetica' | 'Helvetica-Bold';

function charWidth(code: number, font: FontName): number {
  const table = font === 'Helvetica-Bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const index = code - 32;
  return index >= 0 && index < table.length ? (table[index] ?? DEFAULT_WIDTH) : DEFAULT_WIDTH;
}

export function textWidth(text: string, size: number, font: FontName = 'Helvetica'): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch.codePointAt(0) ?? 63, font);
  return (total * size) / 1000;
}

/**
 * WinAnsi's 0x80..0x9F block, which Latin-1 leaves as control characters.
 *
 * Present because generated prose is full of these: an em-dash in a title, a
 * curly apostrophe in a client's name, an ellipsis in a truncated note. Without
 * the map every one of them becomes '?', and a handover document peppered with
 * question marks reads as broken software.
 */
const WIN_ANSI: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

/**
 * PDF string literal, WinAnsi-encoded.
 *
 * Characters that WinAnsi cannot represent at all — CJK, emoji, most of
 * Cyrillic — become '?' rather than being dropped or emitted as raw UTF-8. A
 * dropped character silently changes a hostname; a '?' is visibly wrong, and
 * visible wrongness is what gets reported. The JSON rendering of the same
 * export carries the text unmangled, which is the reason a bundle contains
 * both.
 */
export function encodePdfText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code === 9) out += '    ';
    else {
      const mapped = WIN_ANSI.get(code) ?? (code >= 0xa0 && code <= 0xff ? code : null);
      out += mapped === null ? '?' : String.fromCharCode(mapped);
    }
  }
  return out;
}

export interface TableColumn {
  readonly header: string;
  /** Fraction of the content width, 0..1. Normalised if the row does not sum to 1. */
  readonly width: number;
}

export interface DocumentMeta {
  readonly title: string;
  readonly subtitle?: string;
  /** Repeated at the foot of every page. Classification banners live here. */
  readonly footer?: string;
}

interface PageState {
  content: string[];
  cursorY: number;
}

export class PdfDocument {
  readonly #pages: PageState[] = [];
  #page: PageState;
  readonly #meta: DocumentMeta;

  constructor(meta: DocumentMeta) {
    this.#meta = meta;
    this.#page = this.#newPage();
  }

  #newPage(): PageState {
    const page: PageState = { content: [], cursorY: PAGE_HEIGHT - MARGIN };
    this.#pages.push(page);
    return page;
  }

  /** Start a new page when the next `needed` points would cross the bottom margin. */
  #ensure(needed: number): void {
    if (this.#page.cursorY - needed < MARGIN + 28) {
      this.#page = this.#newPage();
    }
  }

  #draw(text: string, x: number, y: number, size: number, font: FontName, grey = 0): void {
    this.#page.content.push(
      `BT /${font === 'Helvetica-Bold' ? 'F2' : 'F1'} ${size} Tf ` +
        `${grey} ${grey} ${grey} rg ` +
        `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${encodePdfText(text)}) Tj ET`,
    );
  }

  #line(y: number, grey = 0.75): void {
    this.#page.content.push(
      `${grey} ${grey} ${grey} RG 0.5 w ${MARGIN} ${y.toFixed(2)} m ` +
        `${(PAGE_WIDTH - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`,
    );
  }

  heading(text: string, level: 1 | 2 | 3 = 1): this {
    const size = level === 1 ? 18 : level === 2 ? 13 : 11;
    this.#ensure(size + 18);
    this.#page.cursorY -= level === 1 ? 10 : 14;
    this.#draw(text, MARGIN, this.#page.cursorY, size, 'Helvetica-Bold');
    this.#page.cursorY -= size * 0.4 + 6;
    if (level <= 2) {
      this.#line(this.#page.cursorY);
      this.#page.cursorY -= 10;
    }
    return this;
  }

  paragraph(text: string, options: { size?: number; grey?: number } = {}): this {
    const size = options.size ?? 9.5;
    const leading = size * 1.45;

    for (const line of wrap(text, CONTENT_WIDTH, size, 'Helvetica')) {
      this.#ensure(leading);
      this.#page.cursorY -= leading;
      this.#draw(line, MARGIN, this.#page.cursorY, size, 'Helvetica', options.grey ?? 0.15);
    }
    this.#page.cursorY -= 4;
    return this;
  }

  /** Label/value rows, label in bold in a fixed left column. */
  definitions(rows: readonly (readonly [string, string])[], labelWidth = 150): this {
    const size = 9.5;
    const leading = size * 1.5;

    for (const [label, value] of rows) {
      const lines = wrap(value || '—', CONTENT_WIDTH - labelWidth - 8, size, 'Helvetica');
      this.#ensure(leading * lines.length);
      let first = true;

      for (const line of lines) {
        this.#page.cursorY -= leading;
        if (first) {
          this.#draw(label, MARGIN, this.#page.cursorY, size, 'Helvetica-Bold', 0.35);
          first = false;
        }
        this.#draw(line, MARGIN + labelWidth, this.#page.cursorY, size, 'Helvetica', 0.1);
      }
    }
    this.#page.cursorY -= 6;
    return this;
  }

  /**
   * A table. Long cells are truncated with an ellipsis rather than wrapped:
   * a row that silently becomes four rows tall makes an inventory unreadable,
   * and the full value is in the JSON companion of every export.
   */
  table(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): this {
    const size = 8.5;
    const leading = size * 1.7;
    const total = columns.reduce((n, c) => n + c.width, 0) || 1;
    const widths = columns.map((c) => (c.width / total) * CONTENT_WIDTH);

    const drawHeader = (): void => {
      this.#page.cursorY -= leading;
      let x = MARGIN;
      columns.forEach((column, i) => {
        this.#draw(column.header.toUpperCase(), x, this.#page.cursorY, size - 0.5, 'Helvetica-Bold', 0.4);
        x += widths[i] ?? 0;
      });
      this.#page.cursorY -= 4;
      this.#line(this.#page.cursorY);
    };

    this.#ensure(leading * 3);
    drawHeader();

    for (const row of rows) {
      if (this.#page.cursorY - leading < MARGIN + 28) {
        this.#page = this.#newPage();
        drawHeader();
      }
      this.#page.cursorY -= leading;
      let x = MARGIN;
      row.forEach((cell, i) => {
        const width = widths[i] ?? 0;
        this.#draw(truncate(cell, width - 8, size), x, this.#page.cursorY, size, 'Helvetica', 0.1);
        x += width;
      });
    }

    this.#page.cursorY -= 8;
    return this;
  }

  spacer(points = 10): this {
    this.#page.cursorY -= points;
    return this;
  }

  pageBreak(): this {
    this.#page = this.#newPage();
    return this;
  }

  /** Serialise. Cross-reference table offsets are byte offsets, so build on a Buffer. */
  render(): Buffer {
    const total = this.#pages.length;
    const bodies = this.#pages.map((page, index) => {
      const footer: string[] = [];
      const y = MARGIN - 18;

      footer.push(
        `BT /F1 7.5 Tf 0.45 0.45 0.45 rg 1 0 0 1 ${MARGIN} ${y} Tm ` +
          `(${encodePdfText(this.#meta.footer ?? this.#meta.title)}) Tj ET`,
      );

      const label = `Page ${index + 1} of ${total}`;
      const x = PAGE_WIDTH - MARGIN - textWidth(label, 7.5);
      footer.push(
        `BT /F1 7.5 Tf 0.45 0.45 0.45 rg 1 0 0 1 ${x.toFixed(2)} ${y} Tm ` +
          `(${encodePdfText(label)}) Tj ET`,
      );

      return [...page.content, ...footer].join('\n');
    });

    return assemble(bodies, this.#meta);
  }
}

function truncate(text: string, maxWidth: number, size: number): string {
  if (textWidth(text, size) <= maxWidth) return text;
  let out = '';
  for (const ch of text) {
    if (textWidth(`${out}${ch}...`, size) > maxWidth) break;
    out += ch;
  }
  return `${out}...`;
}

function wrap(text: string, maxWidth: number, size: number, font: FontName): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, size, font) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);

      // A single word wider than the line — a long FQDN or a base64 fragment —
      // is broken rather than allowed to run off the page.
      if (textWidth(word, size, font) > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (textWidth(chunk + ch, size, font) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        current = chunk;
      } else {
        current = word;
      }
    }
    lines.push(current);
  }

  return lines.length ? lines : [''];
}

function assemble(bodies: string[], meta: DocumentMeta): Buffer {
  const objects: string[] = [];
  const pageCount = bodies.length;

  // 1 catalog, 2 pages, 3 font, 4 bold font, then per page: page object + stream.
  const pageIds = bodies.map((_, i) => 5 + i * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  bodies.forEach((body, i) => {
    const pageId = pageIds[i] ?? 0;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  });

  const infoId = 5 + pageCount * 2;
  // The /Info dictionary is NOT subject to the font's WinAnsiEncoding — it holds
  // PDF *text strings*, which are PDFDocEncoded or UTF-16BE. Encoding the title
  // the same way as page content puts mojibake in the reader's title bar, which
  // is the first thing anyone sees.
  objects[infoId] =
    `<< /Title ${pdfTextString(meta.title)} /Producer (Lake Effect Helm) ` +
    `/CreationDate (D:${pdfDate(new Date())}) >>`;

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];

  for (let id = 1; id <= infoId; id += 1) {
    const body = objects[id];
    if (!body) continue;
    offsets[id] = offset;
    const chunk = Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, 'latin1');
    chunks.push(chunk);
    offset += chunk.length;
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${infoId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= infoId; id += 1) {
    xref += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${infoId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\n`;
  xref += `startxref\n${xrefOffset}\n%%EOF\n`;

  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

/**
 * A PDF text string: a plain literal while it is ASCII, UTF-16BE with a byte
 * order mark as soon as it is not. Both forms are in the spec; the second is
 * the only one that can carry an em-dash or a client name with an accent.
 */
function pdfTextString(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return `(${encodePdfText(text)})`;

  const utf16 = Buffer.from(`\uFEFF${text}`, 'utf16le').swap16();
  return `<${utf16.toString('hex')}>`;
}

function pdfDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}
