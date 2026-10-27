/**
 * How the extension and Helm's pairing page talk, shared by both sides.
 *
 * 1. The extension makes a device key and opens
 *    `<helm>/extension/pair#key=…&label=…&browser=…&version=…&state=…`.
 *    The fragment never reaches the server or its logs; the page reads it.
 * 2. The person, signed in to Helm in that tab, checks the fingerprint and
 *    presses Pair. The page POSTs the key to /api/extension/installs.
 * 3. The page hands the result to the extension with window.postMessage to
 *    its own origin, carrying the `state` the extension chose. The extension
 *    injected a listener into that one tab when it opened it, accepts only a
 *    message from that page's own window with the matching state, and closes
 *    the tab.
 *
 * So the token goes from the response to the extension inside one tab, and is
 * never in a URL, the history, the clipboard or the person's hands. A page on
 * another origin cannot receive it: the message is addressed to Helm's origin.
 */
export const PAIR_PATH = '/extension/pair';
export const PAIR_MESSAGE_TYPE = 'helm-extension-paired';

export interface PairRequestParams {
  /** SubjectPublicKeyInfo DER, base64url. */
  key: string;
  label: string;
  browser: string;
  version: string;
  /** Random, chosen by the extension, echoed back in the message. */
  state: string;
}

export interface PairMessage {
  type: typeof PAIR_MESSAGE_TYPE;
  state: string;
  installId: string;
  token: string;
  expiresAt: string;
  tenantName: string;
}
