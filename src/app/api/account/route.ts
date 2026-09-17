import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * Your own account.
 *
 * Only the display name is settable, and the omission is deliberate rather than
 * unfinished. `app_user.email` is the identity key three separate things match
 * on: the Entra adapter joins an SSO login to an account by it, RADIUS is asked
 * about it as the username, and every audit row in the deployment resolves
 * through the user it belongs to. A self-service field that silently detaches
 * an account from two directories at once is not a feature.
 *
 * Changing an address is therefore an administrative act — one that belongs
 * next to the directory change it has to be coordinated with, which is the
 * People page. The account page says so instead of offering a box that breaks
 * sign-in. See the note in the commit for what a proper implementation needs.
 *
 * No permission is declared: everybody may edit their own name, and the
 * SECURITY DEFINER function resolves the actor from the session context rather
 * than from anything the caller sends, so there is no other account to reach.
 */
const patchSchema = z.object({
  name: z.string().trim().max(120).nullable(),
});

export const PATCH = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = patchSchema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a display name of at most 120 characters, or null to clear it');
    }
    return result.data;
  });

  const [updated] = await tx<{ set_my_profile: string | null }[]>`
    SELECT helm.set_my_profile(${body.name})
  `;

  return { account: { name: updated?.set_my_profile ?? null } };
});

export const dynamic = 'force-dynamic';
