/**
 * A stub OpenID Connect issuer.
 *
 * Real enough to exercise discovery: it serves a well-known document at the
 * path the spec says (appended to the issuer INCLUDING its path component,
 * which is the detail most setups get wrong), and it can be told to break in
 * each of the ways a real provider breaks.
 *
 * Plain HTTP on purpose. The https requirement belongs to the stored
 * configuration and is enforced by a CHECK constraint and a zod schema, both
 * tested directly; making this server TLS would test Node's trust store rather
 * than Helm's discovery logic, and would need a certificate in the repository.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeOidcMode =
  /** A well-formed OIDC issuer. */
  | 'ok'
  /** No document at the well-known path. */
  | 'not-found'
  /** Something that is not JSON — a proxy's login page, typically. */
  | 'not-json'
  /** Valid JSON, but an OAuth 2.0 server rather than an OIDC one. */
  | 'oauth-only'
  /** A valid document that names a DIFFERENT issuer — the wrong realm. */
  | 'wrong-issuer'
  /** OIDC, but without the authorization code flow. */
  | 'no-code-flow'
  /** Answers, but so slowly that the client gives up. */
  | 'hang';

export class FakeOidc {
  private constructor(
    private readonly server: Server,
    readonly issuer: string,
    /** Every path this server was asked for, in order. */
    readonly requests: string[],
  ) {}

  /**
   * Start a stub on an ephemeral port.
   *
   * `basePath` puts the issuer behind a path segment, so the test can prove
   * discovery appends to the whole issuer rather than going to the host root —
   * the Keycloak-realm case.
   */
  static async start(mode: FakeOidcMode = 'ok', basePath = ''): Promise<FakeOidc> {
    const requests: string[] = [];
    let issuer = '';

    const server = createServer((req, res) => {
      requests.push(req.url ?? '');

      if (req.url !== `${basePath}/.well-known/openid-configuration`) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      if (mode === 'not-found') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no such realm' }));
        return;
      }

      if (mode === 'not-json') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Sign in to the proxy</title>');
        return;
      }

      if (mode === 'hang') {
        // Never respond. The client's own timeout is what ends this.
        return;
      }

      const base = `${issuer}`;
      const doc: Record<string, unknown> = {
        issuer: mode === 'wrong-issuer' ? `${issuer}-somewhere-else` : issuer,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        userinfo_endpoint: `${base}/userinfo`,
        scopes_supported: ['openid', 'profile', 'email'],
        response_types_supported: mode === 'no-code-flow' ? ['id_token'] : ['code'],
        code_challenge_methods_supported: ['S256'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      };

      if (mode === 'oauth-only') {
        delete doc.jwks_uri;
        delete doc.userinfo_endpoint;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    issuer = `http://127.0.0.1:${port}${basePath}`;

    return new FakeOidc(server, issuer, requests);
  }

  stop(): void {
    this.server.closeAllConnections?.();
    this.server.close();
  }
}
