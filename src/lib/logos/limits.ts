/**
 * What a logo may be, in a module the browser can import.
 *
 * SEPARATE FROM service.ts DELIBERATELY, and `src/lib/documents/limits.ts`
 * exists for the same reason. The upload control is a client component — it
 * reads a File off an input — and it needs the limit and the accepted types to
 * say them on screen and to refuse an obvious mistake before spending an
 * upload. Importing them from service.ts would pull `node:crypto`, the database
 * client and the DEK cache into the browser bundle, which fails the build at
 * best and ships server code at worst.
 *
 * So the constants live here, with no imports at all, and both sides use them.
 * The CHECK constraint in 0680 is the third copy and the authoritative one;
 * `tests/integration/logos.test.ts` asserts the three agree.
 */

/** What a browser can be trusted not to execute. Mirrors 0680's CHECK. */
export const LOGO_CONTENT_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
] as const;

export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

/**
 * 512 KB, which is generous for a logo and mean for anything else.
 *
 * Not the document limit: documents are network diagrams and scanned contracts
 * and the cap there is tens of megabytes. A logo that does not fit in half a
 * megabyte is a photograph somebody dragged in by mistake, and refusing it
 * early is kinder than storing it and rendering it at 24 pixels.
 */
export const MAX_LOGO_BYTES = 512 * 1024;
