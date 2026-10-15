import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { THEMES, type Theme } from '@/lib/ui/preferences';

/**
 * Your own account: the display name, its two halves, and your preferences.
 *
 * EMAIL IS STILL NOT SETTABLE, and the omission is deliberate rather than
 * unfinished. `app_user.email` is the identity key three separate things match
 * on: the Entra adapter joins an SSO login to an account by it, RADIUS is asked
 * about it as the username, and every audit row in the deployment resolves
 * through the user it belongs to. A self-service field that silently detaches
 * an account from two directories at once is not a feature. Changing an address
 * is an administrative act that belongs next to the directory change it has to
 * be coordinated with, which is the People page.
 *
 * ONE SCOPED UPDATE, NOT helm.set_my_profile(). That function is SECURITY
 * DEFINER, owned by postgres, and therefore runs as a superuser with RLS
 * switched off — its `WHERE id = v_actor` is the only thing confining it. A
 * plain UPDATE from here is confined twice: by the predicate below AND by
 * app_user_rls_update. 0630's header has the full reasoning.
 *
 * THE `WHERE id` IS LOAD-BEARING AND NOT REDUNDANT. app_user_rls_update is
 * `id = helm.current_actor_id() OR helm.has_permission('user:write')`, because
 * an administrator must be able to edit a colleague from the People page. So
 * the policy alone would let a super_admin's "save my preferences" rewrite
 * every row in the tenant. The predicate here is what makes this route about
 * one account, and tests/integration/preferences.test.ts proves it by sending
 * this request as somebody holding user:write.
 *
 * WHEN A SAVE INCLUDES THE NAME HALVES, THEY WIN. 0630's trigger composes
 * `name` from them, and it fires on this statement because the halves are in
 * the SET list. Sending a display name alongside new halves therefore stores
 * the composed name, not the typed one — which is why the form derives the box
 * from the halves rather than offering two independent answers.
 *
 * No permission is declared: everybody may edit their own account.
 */
const patchSchema = z
  .object({
    name: z.string().trim().max(120).nullable().optional(),
    firstName: z.string().trim().max(60).nullable().optional(),
    lastName: z.string().trim().max(60).nullable().optional(),
    /**
     * An IANA zone name, or null for "no preference". Bounded at 64 because
     * the longest in the tzdata is well under it; the database is the real
     * check — a trigger looks the value up in pg_timezone_names, so an
     * unknown-but-plausible string is refused there rather than stored and
     * surfacing later as a 500 on any page that renders a date.
     */
    timezone: z.string().trim().max(64).nullable().optional(),
    theme: z.enum(THEMES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

interface AccountRow {
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  timezone: string | null;
  theme: Theme;
}

export const PATCH = tenantRoute(async ({ tx, request, identity }) => {
  const body = await readJson(request, (raw) => {
    const result = patchSchema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a name of at most 120 characters, name halves of 60, an IANA time zone, or a known theme', {
        issues: zodIssues(result.error),
      });
    }
    return result.data;
  });

  /*
   * `undefined` means "leave alone" and `null` means "clear", which is why
   * every field is `tx`-interpolated through a ternary rather than COALESCEd.
   * COALESCE cannot tell the two apart: `COALESCE(${null}, timezone)` keeps the
   * old value, so clearing a time zone would silently do nothing.
   *
   * nullif(btrim(...), '') normalises a cleared box to NULL rather than the
   * blank string app_user_name_parts_not_blank refuses — the form sends '' for
   * an emptied field and a 500 would be a poor way to learn that.
   */
  const blankToNull = (value: string | null | undefined) =>
    value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim();

  const name = blankToNull(body.name);
  const firstName = blankToNull(body.firstName);
  const lastName = blankToNull(body.lastName);
  const timezone = blankToNull(body.timezone);

  // An unknown time zone is refused by a trigger with invalid_parameter_value
  // and a `helm:` message naming the zone; the handler maps it to a 400.
  const [updated] = await tx<AccountRow[]>`
    UPDATE app_user SET
      name       = ${name === undefined ? tx`name` : name},
      first_name = ${firstName === undefined ? tx`first_name` : firstName},
      last_name  = ${lastName === undefined ? tx`last_name` : lastName},
      timezone   = ${timezone === undefined ? tx`timezone` : timezone},
      theme      = ${body.theme === undefined ? tx`theme` : body.theme},
      updated_at = now()
    WHERE id = ${identity.actorId}::uuid
    RETURNING name, first_name, last_name, timezone, theme
  `;

  // The policy matched no row, which here means the actor's own row is gone —
  // a deactivated account mid-request. Not a 404: the request was about an
  // identity that no longer exists, which is an authentication problem.
  if (!updated) throw ApiError.forbidden('this account no longer exists');

  return {
    account: {
      name: updated.name,
      firstName: updated.first_name,
      lastName: updated.last_name,
      timezone: updated.timezone,
      theme: updated.theme,
    },
  };
});

export const dynamic = 'force-dynamic';
