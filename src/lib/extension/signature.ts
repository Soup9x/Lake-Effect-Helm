/**
 * What the browser extension signs, shared by the extension and the server.
 *
 * Every request an extension token authenticates carries a signature by the
 * device key the extension made when it was paired (1120). The token alone is
 * not enough: it sits in the extension's storage, and a token that leaks from
 * there, from a log or from a proxy must not be a key to the vault. The
 * private half of the device key is a non-extractable WebCrypto key, so a
 * script that reads the extension's storage gets a handle it cannot export.
 *
 * WHAT IS COVERED: the method, the path with its query, the time, and a
 * SHA-256 of the body. So a signature cannot be lifted onto another route,
 * another credential id, another body, or replayed after the window closes.
 *
 * THE WINDOW is five minutes either side, for clocks that disagree. A request
 * replayed inside it by somebody who captured it in transit is not defended
 * against here; that person already holds the TLS session's plaintext.
 *
 * This module is imported by the extension's bundle as well as the server, so
 * it stays free of Node and of the DOM: strings in, a string out.
 */

export const SIGNATURE_VERSION = 'helm-ext-v1';

export const SIGNATURE_HEADER = 'x-helm-device-signature';
export const TIMESTAMP_HEADER = 'x-helm-device-timestamp';

/** How far a request's timestamp may be from the server's clock. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export interface SignedParts {
  method: string;
  /** The path and query exactly as requested: `/api/extension/match?x=1`. */
  pathAndQuery: string;
  /** Milliseconds since the epoch, as sent in the timestamp header. */
  timestamp: string;
  /** Lowercase hex SHA-256 of the raw body; of the empty string when there is none. */
  bodySha256: string;
}

export function canonicalRequest(parts: SignedParts): string {
  return [
    SIGNATURE_VERSION,
    parts.method.toUpperCase(),
    parts.pathAndQuery,
    parts.timestamp,
    parts.bodySha256.toLowerCase(),
  ].join('\n');
}

/** SHA-256 of nothing, which is what a bodiless request signs. */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
