/**
 * How people sign in, as the settings page reads it.
 *
 * Settings only, never the secret: helm.oidc_settings() and
 * helm.radius_settings() return no column that could carry one, and helm_app
 * could not read it if they did. `secretSet` is a boolean the database
 * computed.
 */
import type { HelmTx } from '../db/client';
import type { OidcSettings } from '@/components/oidc-settings';
import type { RadiusSettings } from '@/components/radius-settings';
import { redirectUri } from './oidc';

interface RadiusRow {
  enabled: boolean;
  host: string;
  port: number;
  timeout_ms: number;
  retries: number;
  nas_identifier: string;
  secret_set: boolean;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
}

interface OidcRow {
  enabled: boolean;
  slug: string;
  display_name: string;
  issuer: string;
  client_id: string;
  scopes: string[];
  allow_signup: boolean;
  link_by_email: boolean;
  secret_set: boolean;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
}

/**
 * The redirect URI is COMPUTED from the origin this page was served on, never
 * stored. It has to be the URL the callback will actually arrive at, and the
 * only thing that knows that is the request — behind Caddy, that means the
 * forwarded host. A stored copy would drift from reality, and this is the one
 * value in an OIDC setup whose mismatch produces an error at the provider
 * rather than anywhere an operator would think to look.
 */
export function toOidcSettings(row: OidcRow | null, origin: string): OidcSettings | null {
  if (!row) return null;
  return {
    configured: true,
    enabled: row.enabled,
    slug: row.slug,
    displayName: row.display_name,
    issuer: row.issuer,
    clientId: row.client_id,
    scopes: row.scopes,
    allowSignup: row.allow_signup,
    linkByEmail: row.link_by_email,
    secretSet: row.secret_set,
    redirectUri: redirectUri(origin, row.slug),
    lastTestAt: row.last_test_at?.toISOString() ?? null,
    lastTestOk: row.last_test_ok,
    lastTestError: row.last_test_error,
    deadEnd: row.enabled && !row.allow_signup && !row.link_by_email,
  };
}

export function toRadiusSettings(row: RadiusRow | null): RadiusSettings | null {
  if (!row) return null;
  return {
    configured: true,
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    timeoutMs: row.timeout_ms,
    retries: row.retries,
    nasIdentifier: row.nas_identifier,
    secretSet: row.secret_set,
    lastTestAt: row.last_test_at?.toISOString() ?? null,
    lastTestOk: row.last_test_ok,
    lastTestError: row.last_test_error,
  };
}


/** `origin` is the address this page was served on; see toOidcSettings. */
export async function readOidcSettings(tx: HelmTx, origin: string): Promise<OidcSettings | null> {
  const [row] = await tx<OidcRow[]>`SELECT * FROM helm.oidc_settings()`;
  return toOidcSettings(row ?? null, origin);
}

export async function readRadiusSettings(tx: HelmTx): Promise<RadiusSettings | null> {
  const [row] = await tx<RadiusRow[]>`SELECT * FROM helm.radius_settings()`;
  return toRadiusSettings(row ?? null);
}
