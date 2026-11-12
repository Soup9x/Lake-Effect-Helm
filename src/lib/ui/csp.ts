/**
 * Helm's Content Security Policy for its pages.
 *
 * WHAT IT IS FOR. Helm escapes everything it renders, and React does that by
 * construction, so there is no known way to get a script into a page. This is
 * the second lock for the day there is one: a credential vault where an
 * injected script could press Reveal as the person looking at it. With this
 * policy the browser runs only scripts that carry this response's nonce (and
 * what those load), talks only to Helm, and posts forms only to Helm, so
 * markup that slipped through could neither run nor send anything away.
 *
 * script-src   A fresh nonce per response, and 'strict-dynamic' so the chunks
 *              Next.js's own nonce-carrying scripts load are trusted in turn.
 *              No 'unsafe-inline': an inline script without the nonce does not
 *              run. Next.js reads the nonce from the request header the proxy
 *              sets and puts it on everything it emits; Helm's own three
 *              inline scripts (the theme, before first paint) take it from
 *              cspNonce().
 * style-src    'unsafe-inline', deliberately. React writes style="" attributes
 *              (the diagram editor positions every box with one), and a nonce
 *              cannot cover an attribute. A style cannot read a password field
 *              or call the API; the script rule is the one that matters.
 * img-src      Helm itself, plus data: and blob: for the authenticator QR code
 *              and the diagram editor's exports. No other origin: logos and
 *              avatars are served by Helm.
 * connect-src  Helm only. Nothing a page runs may send data anywhere else.
 * frame-ancestors 'none', with X-Frame-Options: DENY beside it (next.config.ts).
 *
 * In development React needs eval for its error overlay, and the dev server
 * its websocket; neither is granted in a production build.
 *
 * /embed/ (the Homarr status page) and the API's file responses set their own,
 * stricter policies, and the proxy leaves them alone.
 */
export const NONCE_HEADER = 'x-nonce';

export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
