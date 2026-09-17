import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { sealRadiusSecret } from '@/lib/auth/radius-config';
import { RadiusConfigurationError, validateServer } from '@/lib/auth/radius';

/**
 * RADIUS server configuration.
 *
 * THE SHARED SECRET ONLY EVER TRAVELS INWARDS. No response shape here carries
 * it, and helm_app — the role these handlers run as — cannot read the column it
 * lives in even if one did (0360 asserts that, at migration time). `secretSet`
 * is the only thing the browser is told: whether one exists.
 *
 * GET is open to any tenant-wide role, because "is this deployment behind
 * RADIUS" is something a Tier 3 engineer on a support call needs to know. Every
 * write requires tenant:write, which only super_admin holds: changing how an
 * entire MSP authenticates is a larger act than configuring an integration, and
 * integration:manage reaches down to tier3.
 */
const settingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  timeoutMs: z.number().int().min(500).max(30_000),
  retries: z.number().int().min(0).max(5),
  nasIdentifier: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,63}$/, 'may contain letters, digits, dot, underscore and hyphen'),
  /**
   * Absent means "leave the stored secret alone", which is what an
   * administrator adjusting a timeout wants. Demanding it on every save is how
   * a shared secret ends up in a team password note so it can be re-typed.
   */
  secret: z.string().min(1).max(253).optional(),
});

interface SettingsRow {
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
  updated_at: Date;
}

function present(row: SettingsRow | undefined) {
  if (!row) return { configured: false as const };
  return {
    configured: true as const,
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
    updatedAt: row.updated_at.toISOString(),
  };
}

export const GET = tenantRoute(async ({ tx }) => {
  const [row] = await tx<SettingsRow[]>`SELECT * FROM helm.radius_settings()`;
  return { radius: present(row) };
});

export const PUT = tenantRoute(
  async ({ tx, request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = settingsSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid RADIUS settings', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const [existing] = await tx<SettingsRow[]>`SELECT * FROM helm.radius_settings()`;

    if (!existing && body.secret === undefined) {
      throw ApiError.invalid('a shared secret is required the first time RADIUS is configured');
    }

    if (body.secret !== undefined) {
      // Validate the whole server, not just the secret: a 12-character secret
      // and a nonsense timeout should both be refused here, where the message
      // can say why, rather than by a CHECK constraint at write time.
      try {
        validateServer({
          host: body.host,
          port: body.port,
          secret: body.secret,
          timeoutMs: body.timeoutMs,
          retries: body.retries,
          nasIdentifier: body.nasIdentifier,
        });
      } catch (error) {
        if (error instanceof RadiusConfigurationError) throw ApiError.invalid(error.message);
        throw error;
      }

      // Encrypted here, in the application, because this is where the KEK
      // provider is. The database is handed ciphertext and has never been able
      // to produce plaintext from it.
      const sealed = await sealRadiusSecret(session.tenantId, body.secret);

      await tx`
        SELECT helm.set_radius_config(
          ${body.enabled}, ${body.host}, ${body.port}, ${body.timeoutMs},
          ${body.retries}::smallint, ${body.nasIdentifier},
          ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
          ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
      `;
    } else {
      const [updated] = await tx<{ update_radius_settings: boolean }[]>`
        SELECT helm.update_radius_settings(
          ${body.enabled}, ${body.host}, ${body.port}, ${body.timeoutMs},
          ${body.retries}::smallint, ${body.nasIdentifier})
      `;
      if (!updated?.update_radius_settings) {
        throw ApiError.notFound('there is no RADIUS configuration to update');
      }
    }

    const [row] = await tx<SettingsRow[]>`SELECT * FROM helm.radius_settings()`;
    return { radius: present(row) };
  },
  { permissions: ['tenant:write'] },
);

/**
 * Forget the server entirely.
 *
 * DELETE rather than `enabled = false`, so a decommissioned RADIUS server does
 * not leave its shared secret sitting in the database until somebody notices.
 * Turning it off without forgetting it is a PUT with enabled false.
 */
export const DELETE = tenantRoute(
  async ({ tx }) => {
    const [gone] = await tx<{ forget_radius_config: boolean }[]>`
      SELECT helm.forget_radius_config()
    `;
    if (!gone?.forget_radius_config) {
      throw ApiError.notFound('there is no RADIUS configuration to remove');
    }
    return { radius: { configured: false as const } };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
