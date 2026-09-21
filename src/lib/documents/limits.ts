/**
 * What may be uploaded, how big, and what the browser is allowed to do with it
 * on the way back out.
 *
 * THERE WAS NO LIST BEFORE THIS ONE. `attachment` has existed since 0130 with
 * no upload path in the product, so there is no established block list to
 * reuse — this is the first, and it is deliberately narrow. An MSP's
 * documentation is whatever the client's estate produced: .vsdx, .pcap, .iso,
 * .bin firmware, .csv exports, .pfx bundles, screenshots of a BIOS screen. A
 * type allowlist would be a support queue.
 *
 * SO THE REAL CONTROL IS NOT THIS LIST. A blocked extension stops the obvious
 * case and nothing else: rename malware.exe to malware.txt and it uploads. What
 * actually makes a download safe is how it is SERVED — every response carries
 * Content-Disposition: attachment, X-Content-Type-Options: nosniff, and
 * application/octet-stream for anything not on a very short render-safe list,
 * so no stored file is ever executed or scripted by a browser that fetched it
 * from Helm's origin. See src/app/api/documents/[attachmentId]/download.
 *
 * The list below is therefore aimed at the other risk: a technician who
 * downloads what they believe is documentation and double-clicks it. Two
 * families, and nothing else:
 *
 *   things Windows executes on double-click — .exe and its installer and
 *   shortcut relatives, which are never documentation; and
 *
 *   scripts, which are sometimes documentation. A PowerShell runbook is a real
 *   thing an MSP keeps. It is still refused, because "a script somebody stored
 *   here for reference" and "a script somebody stored here to be run later" are
 *   indistinguishable at upload time. Store it as .ps1.txt, or as a note, which
 *   is what the product already has for procedures.
 */

/** 50 MB, unless the deployment says otherwise. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Never documentation. Windows runs most of these from a double-click, and the
 * rest are how one becomes the other.
 */
const BLOCKED_EXECUTABLE = [
  'exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'mst', 'msc',
  'dll', 'sys', 'drv', 'ocx', 'gadget', 'application', 'appref-ms',
  'lnk', 'scf', 'url', 'reg', 'hta', 'jar', 'hlp', 'chm',
];

/** Sometimes documentation, still refused. See the note above. */
const BLOCKED_SCRIPT = [
  'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'wsf', 'wsh',
  'ps1', 'psm1', 'psd1', 'sh', 'bash', 'zsh', 'ksh', 'csh', 'fish',
  'py', 'pyw', 'pl', 'rb', 'php', 'jsp', 'asp', 'aspx', 'cgi',
];

export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  ...BLOCKED_EXECUTABLE,
  ...BLOCKED_SCRIPT,
]);

/**
 * Types a browser may render inline without being able to run anything.
 *
 * SVG is absent on purpose: it is a document format that executes script, and
 * it is the one image type that would turn "preview this attachment" into
 * stored XSS on Helm's own origin. Everything not listed here is served as
 * application/octet-stream.
 */
const RENDER_SAFE: ReadonlySet<string> = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export type UploadRefusal =
  | { code: 'filename_required'; message: string }
  | { code: 'filename_invalid'; message: string }
  | { code: 'filename_too_long'; message: string }
  | { code: 'file_empty'; message: string }
  | { code: 'file_too_large'; message: string }
  | { code: 'file_type_blocked'; message: string };

export type UploadCheck =
  | { ok: true; filename: string; extension: string | null }
  | { ok: false; refusal: UploadRefusal };

/** The bytes after the LAST dot, lowercased. Null when there is no extension. */
export function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Strip a filename down to a name.
 *
 * A browser sends whatever the operating system gave it, which on some paths is
 * `C:\Users\tech\Desktop\diagram.vsdx`. Taking the last segment of BOTH
 * separators matters: splitting on '/' alone leaves the Windows path intact as
 * one long "filename", and that string then goes into a unique index and a
 * search title.
 */
export function baseName(raw: string): string {
  const segments = raw.split(/[/\\]/);
  return (segments[segments.length - 1] ?? '').trim();
}

/**
 * The size cap, from the environment, so a deployment can raise or lower it.
 *
 * Takes the raw value as a parameter rather than reading the environment inside
 * the body: the parsing is what is worth testing, and mutating process.env in a
 * test suite that does not run files in isolation is how one test starts
 * depending on another. The default still names the variable literally, which
 * is what tests/unit/env-docs.test.ts scans for.
 */
export function maxUploadBytes(configured = process.env.HELM_DOCUMENT_MAX_BYTES): number {
  const raw = configured?.trim();
  if (!raw) return DEFAULT_MAX_BYTES;

  const parsed = Number(raw);
  // Junk, zero and negatives fall back rather than disabling the cap. A
  // deployment that fat-fingers this should not end up with no limit at all.
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_MAX_BYTES;
  return parsed;
}

/** What to send a browser as the content type. */
export function safeContentType(stored: string): string {
  return RENDER_SAFE.has(stored.toLowerCase()) ? stored : 'application/octet-stream';
}

export function checkUpload(input: {
  filename: string;
  byteSize: number;
  maxBytes?: number;
}): UploadCheck {
  const maxBytes = input.maxBytes ?? maxUploadBytes();
  const filename = baseName(input.filename);

  if (filename.length === 0) {
    return { ok: false, refusal: { code: 'filename_required', message: 'the file needs a name' } };
  }
  // `.` and `..` are directory entries, not names, and a leading dot on its own
  // produces a row whose title renders as nothing.
  if (/^\.+$/.test(filename)) {
    return {
      ok: false,
      refusal: { code: 'filename_invalid', message: 'that is not a filename' },
    };
  }
  // Control characters render as nothing, so two files look identical in a list
  // and only one of them is the one somebody meant.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(filename)) {
    return {
      ok: false,
      refusal: { code: 'filename_invalid', message: 'the name contains control characters' },
    };
  }
  if (filename.length > 200) {
    return {
      ok: false,
      refusal: { code: 'filename_too_long', message: 'the name may be at most 200 characters' },
    };
  }

  if (input.byteSize <= 0) {
    return { ok: false, refusal: { code: 'file_empty', message: 'the file is empty' } };
  }
  if (input.byteSize > maxBytes) {
    return {
      ok: false,
      refusal: {
        code: 'file_too_large',
        message:
          `the file is ${describeBytes(input.byteSize)}; the limit is ` +
          `${describeBytes(maxBytes)} (HELM_DOCUMENT_MAX_BYTES)`,
      },
    };
  }

  const extension = extensionOf(filename);
  if (extension && BLOCKED_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      refusal: {
        code: 'file_type_blocked',
        message:
          `.${extension} files are not accepted. Executables and scripts are refused ` +
          'whatever they contain; store a script as a note, or rename it to .txt.',
      },
    };
  }

  return { ok: true, filename, extension };
}

export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
