import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { sealOidcSecret } from '@/lib/auth/oidc-config';
import { redirectUri } from '@/lib/auth/oidc';

/**
 * Generic OIDC provider configuration.
 *
 * THE CLIENT SECRET ONLY EVER TRAVELS INWARDS. No response shape here carries
 * it, and helm_app — the role these handlers run as — cannot read the column it
 * lives in even if one did (0410 asserts that per column, at migration time).
 * `secretSet` is the only thing the browser is told: whether one exists.
 *
 * GET is open to any tenant-wide role, because "what does this deployment sign
 * in against" is something a Tier 3 engineer on a support call needs to know.
 * Every write requires tenant:write, which only super_admin holds — the same
 * bar RADIUS sits behind, and for the same reason: changing how an entire MSP
 * authenticates is a larger act than configuring an integration.
 */

/**
 * The slug becomes a URL path segment and is registered by hand at the identity
 * provider, so its shape is checked here as well as by a CHECK constraint. The
 * reserved list mirrors the constraint: a slug colliding with a built-in
 * provider id would shadow it, and 'microsoft-entra-id' shadowing Entra means
 * the SSO button silently starts pointing somewhere else.
 */
const RESERVED = ['microsoft-entra-id', 'credentials', 'email', 'webauthn', 'nodemailer'];

const settingsSchema = z.object({
  enabled: z.boolean(),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'lowercase letters, digits and hyphens')
    .refine((s) => !RESERVED.includes(s), 'that name is reserved for a built-in sign-in method'),
  displayName: z.string().trim().min(1).max(60),
  issuer: z
    .string()
    .trim()
    .url()
    .refine((u) => u.startsWith('https://'), 'the issuer must be https')
    .refine((u) => !u.endsWith('/'), 'drop the trailing slash — discovery appends to this exactly')
    .refine((u) => {
      try {
        const parsed = new URL(u);
        return parsed.search === '' && parsed.hash === '';
      } catch {
        return false;
      }
    }, 'the issuer is a base URL, with no query string or fragment'),
  clientId: z.string().trim().min(1).max(255),
  scopes: z
    .array(z.string().trim().regex(/^[A-Za-z0-9_.:/-]{1,64}$/))
    .min(1)
    .max(20)
    .refine((s) => s.includes('openid'), 'openid is required — it is what makes this OIDC'),
  allowSignup: z.boolean(),
  linkByEmail: z.boolean(),
  /**
   * Absent means "leave the stored secret alone", which is what an
   * administrator adding a scope wants. Demanding it on every save is how a
   * client secret ends up in a team note so it can be re-typed.
   */
  clientSecret: z.string().min(1).max(1024).optional(),
});

interface SettingsRow {
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
  updated_at: Date;
}

/**
 * The origin to build the redirect URI from.
 *
 * Taken from the request rather than from configuration, because the value an
 * operator has to paste into their IdP is the one for the host they are
 * actually reached on. Behind Caddy that is the forwarded host, which is why
 * the proxy headers are consulted first.
 */
function originOf(request: Request): string {
  const configured = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (configured) return configured.replace(/\/+$/, '');

  const headers = request.headers;
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  const proto = headers.get('x-forwarded-proto') ?? 'https';
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

function present(row: SettingsRow | undefined, origin: string) {
  if (!row) return { configured: false as const };
  return {
    configured: true as const,
    enabled: row.enabled,
    slug: row.slug,
    displayName: row.display_name,
    issuer: row.issuer,
    clientId: row.client_id,
    scopes: row.scopes,
    allowSignup: row.allow_signup,
    linkByEmail: row.link_by_email,
    secretSet: row.secret_set,
    /**
     * Computed, never stored. The redirect URI is a function of the deployment
     * origin and the slug; persisting it would let it drift from the URL the
     * callback actually arrives on, which is the one failure in an OIDC setup
     * that produces an error at the provider rather than in Helm.
     */
    redirectUri: redirectUri(origin, row.slug),
    lastTestAt: row.last_test_at?.toISOString() ?? null,
    lastTestOk: row.last_test_ok,
    lastTestError: row.last_test_error,
    updatedAt: row.updated_at.toISOString(),
    /**
     * A configuration that is switched on but can neither create an account nor
     * attach to one. Existing links still work, so this is a legitimate
     * lockdown rather than an error — but as a first-time setup it is a dead
     * end, and it is the sort of thing somebody discovers at 8am.
     *
     * Reported rather than refused, because refusing would also block the
     * lockdown case, which is real.
     */
    deadEnd: row.enabled && !row.allow_signup && !row.link_by_email,
  };
}

export const GET = tenantRoute(async ({ tx, request }) => {
  const [row] = await tx<SettingsRow[]>`SELECT * FROM helm.oidc_settings()`;
  return { oidc: present(row, originOf(request)) };
});

export const PUT = tenantRoute(
  async ({ tx, request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = settingsSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid OIDC settings', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const [existing] = await tx<SettingsRow[]>`SELECT * FROM helm.oidc_settings()`;

    if (!existing && body.clientSecret === undefined) {
      throw ApiError.invalid('a client secret is required the first time a provider is configured');
    }

    // Caught here so the message can explain the consequence. The database
    // refuses it too, with a message about a column.
    if (existing && existing.slug !== body.slug) {
      throw ApiError.invalid(
        `the sign-in path cannot be changed once it is registered (it is "${existing.slug}"). ` +
          'Remove the provider and configure it again, then update the redirect URI at the ' +
          'identity provider to match.',
      );
    }

    if (body.clientSecret !== undefined) {
      // Encrypted here, in the application, because this is where the KEK
      // provider is. The database is handed ciphertext and has never been able
      // to produce plaintext from it.
      const sealed = await sealOidcSecret(session.tenantId, body.clientSecret);

      await tx`
        SELECT helm.set_oidc_provider(
          ${body.enabled}, ${body.slug}, ${body.displayName}, ${body.issuer},
          ${body.clientId}, ${body.scopes}::text[],
          ${body.allowSignup}, ${body.linkByEmail},
          ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
          ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
      `;
    } else {
      const [updated] = await tx<{ update_oidc_settings: boolean }[]>`
        SELECT helm.update_oidc_settings(
          ${body.enabled}, ${body.displayName}, ${body.issuer}, ${body.clientId},
          ${body.scopes}::text[], ${body.allowSignup}, ${body.linkByEmail})
      `;
      if (!updated?.update_oidc_settings) {
        throw ApiError.notFound('there is no OIDC provider to update');
      }
    }

    const [row] = await tx<SettingsRow[]>`SELECT * FROM helm.oidc_settings()`;
    return { oidc: present(row, originOf(request)) };
  },
  { permissions: ['tenant:write'] },
);

/**
 * Forget the provider entirely.
 *
 * DELETE rather than `enabled = false`, so a decommissioned provider does not
 * leave its client secret sitting in the database until somebody notices.
 * Turning it off without forgetting it is a PUT with enabled false.
 */
export const DELETE = tenantRoute(
  async ({ tx }) => {
    const [gone] = await tx<{ forget_oidc_provider: boolean }[]>`
      SELECT helm.forget_oidc_provider()
    `;
    if (!gone?.forget_oidc_provider) {
      throw ApiError.notFound('there is no OIDC provider to remove');
    }
    return { oidc: { configured: false as const } };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
