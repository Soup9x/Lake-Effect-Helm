import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { checkPasswordPolicy, hashPassword } from '@/lib/auth/password';

/**
 * POST /api/users/[userId]/password — an administrator acts on somebody's
 * local sign-in (1000).
 *
 *   { action: 'email' }            email a link: to choose a first password if
 *                                  they have none, else to reset theirs
 *   { action: 'access_email' }     email them that they have access (single
 *                                  sign-on people)
 *   { action: 'set', password,     set it here and hand it over; mustChange
 *     mustChange }                 makes them replace it at first sign-in
 *
 * The rules are the database's (helm.admin_set_local_password,
 * helm.queue_account_email): user:write, a member here, not outranking you,
 * and not a member of another MSP. The out-of-band code read down the phone is
 * still POST /api/auth/local/reset with outOfBand.
 */
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('email') }),
  z.object({ action: z.literal('access_email') }),
  z.object({
    action: z.literal('set'),
    password: z.string().min(1).max(256),
    mustChange: z.boolean().default(true),
  }),
]);

export const POST = tenantRoute(
  async ({ tx, request, params }) => {
    const userId = z.guid().safeParse(params.userId);
    if (!userId.success) throw ApiError.invalid('userId must be a UUID');
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid request', { issues: zodIssues(result.error) });
      return result.data;
    });

    const [state] = await tx<{ has_local_password: boolean; email: string; name: string | null }[]>`
      SELECT s.has_local_password, u.email, u.name
      FROM helm.member_sign_in_state() s JOIN app_user u ON u.id = s.user_id
      WHERE s.user_id = ${userId.data}::uuid
    `;
    if (!state) throw ApiError.notFound('no member of this tenant with that id');

    if (body.action === 'set') {
      const policy = checkPasswordPolicy(body.password, { email: state.email, name: state.name ?? '' });
      if (!policy.ok) {
        throw ApiError.invalid(`the password ${policy.problems.join('; ')}`, { problems: policy.problems });
      }
      const phc = await hashPassword(body.password);
      await tx`SELECT helm.admin_set_local_password(${userId.data}::uuid, ${phc}, ${body.mustChange})`;
      return { set: true, mustChange: body.mustChange };
    }

    const kind = body.action === 'access_email'
      ? 'access_granted'
      : state.has_local_password ? 'password_reset' : 'password_setup';
    await tx`SELECT helm.queue_account_email(${userId.data}::uuid, ${kind})`;
    return { emailQueued: kind };
  },
  { permissions: ['user:write'] },
);

export const dynamic = 'force-dynamic';
