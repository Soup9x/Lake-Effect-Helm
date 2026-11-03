/**
 * Field view, as a server component asks about it: is the session behind this
 * page a phone (Field view) session? (1250)
 */
import { cookies } from 'next/headers';
import { sessionCookieName } from './session-cookie';
import { sessionIsField } from './field-session';

export async function currentSessionIsField(): Promise<boolean> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  return token ? sessionIsField(token) : false;
}
