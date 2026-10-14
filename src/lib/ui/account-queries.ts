/**
 * Reading your own account row.
 *
 * READ THROUGH RLS, with an explicit `WHERE id`, and both halves matter.
 * app_user_rls_select is "my own row, OR somebody who shares my tenant" —
 * deliberately, because the People page lists colleagues — so the policy alone
 * would return the whole tenant here. The predicate is what makes this about
 * one account; the policy is what stops it reaching another tenant's.
 *
 * Not a SECURITY DEFINER function, for the reason 0630's header gives at
 * length: app_user holds no credential material (that is local_credential,
 * 0340) and helm_app may read it under RLS, so a definer function would
 * replace two locks with one.
 */
import { withTenant } from '../db/client';
import { actorOf, type ServerIdentity } from '../auth/server-identity';
import { readTheme, type AccountPreferences } from './preferences';

interface Row {
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  timezone: string | null;
  theme: string;
}

export async function readMyPreferences(identity: ServerIdentity): Promise<AccountPreferences> {
  const [row] = await withTenant(actorOf(identity), (tx) => tx<Row[]>`
    SELECT name, first_name, last_name, timezone, theme
    FROM app_user WHERE id = ${identity.actorId}::uuid
  `);

  /*
   * A missing row is not an error here. The session resolved, so the account
   * existed a moment ago; if it has just been deactivated the shell should
   * still render — the next request will be refused by the auth layer, which is
   * the right place for that. Falling back to defaults beats a 500 on every
   * page because somebody was offboarded mid-session.
   */
  return {
    name: row?.name ?? null,
    firstName: row?.first_name ?? null,
    lastName: row?.last_name ?? null,
    timezone: row?.timezone ?? null,
    theme: readTheme(row?.theme),
  };
}
