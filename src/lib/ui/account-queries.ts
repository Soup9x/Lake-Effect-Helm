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
import { unreadCount } from '../notifications/inbox';
import { readTheme, type AccountPreferences } from './preferences';
import { avatarUrls } from '../avatars/service';

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

/**
 * Everything the shell needs about the acting user, in ONE transaction.
 *
 * The layout under (app) renders on every navigation, so each query it makes is
 * a cost paid continuously. The theme has to be read there — it is applied
 * before the page below paints — and 0700's unread count has to be read there
 * too, because the bell is in the header on every page. Two reads, one
 * transaction, one session context: a second withTenant() would open a second
 * connection and set the context again for a count.
 *
 * The count is NOT fetched by the bell on open, unlike the list. A badge that
 * only appears once somebody clicks the thing it is meant to draw them to is
 * not a badge.
 */
export interface ShellState {
  preferences: AccountPreferences;
  unreadNotifications: number;
  /** The signed-in person's effective idle timeout (0890), for the shell's warning. */
  idleMinutes: number;
  /** Their profile picture (1040), for the account menu, or null. */
  avatarUrl: string | null;
}

export async function readShellState(identity: ServerIdentity): Promise<ShellState> {
  return withTenant(actorOf(identity), async (tx) => {
    const [row] = await tx<Row[]>`
      SELECT name, first_name, last_name, timezone, theme
      FROM app_user WHERE id = ${identity.actorId}::uuid
    `;
    return {
      // Same fallback as readMyPreferences, and for the reason stated there: a
      // session that resolved against an account deactivated a moment ago
      // should still render a shell rather than 500 on every page.
      preferences: {
        name: row?.name ?? null,
        firstName: row?.first_name ?? null,
        lastName: row?.last_name ?? null,
        timezone: row?.timezone ?? null,
        theme: readTheme(row?.theme),
      },
      unreadNotifications: await unreadCount(tx),
      idleMinutes: (await tx<{ idle_minutes: number }[]>`
        SELECT idle_minutes FROM helm.my_session_policy()
      `)[0]?.idle_minutes ?? 480,
      avatarUrl: (await avatarUrls(tx, [identity.actorId])).get(identity.actorId) ?? null,
    };
  });
}
