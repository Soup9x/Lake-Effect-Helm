/**
 * Field view, as a server component asks about it: is the session behind this
 * page a phone (Field view) session? (1250)
 */
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { sessionCookieName } from './session-cookie';
import { FIELD_READ_ONLY_MESSAGE, fieldMayCall, sessionIsField } from './field-session';

export async function currentSessionIsField(): Promise<boolean> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  return token ? sessionIsField(token) : false;
}

/**
 * The same read-only rule resolveSessionIdentity() applies (identity.ts), for
 * the few routes that find the signed-in person through getServerIdentity()
 * instead and so never pass through it: the account's own password, its
 * authenticator, and an administrator's reset link for somebody else.
 *
 * Returns the refusal to send, or null when the request may go on. A Field
 * view session is refused every write that is not on fieldMayCall()'s list,
 * so a phone left unlocked cannot enrol an authenticator or mint a reset link
 * any more than it can edit a record.
 */
export async function refuseFieldWrite(request: NextRequest): Promise<NextResponse | null> {
  if (fieldMayCall(request.method, request.nextUrl.pathname)) return null;
  const token = request.cookies.get(sessionCookieName())?.value;
  if (!token || !(await sessionIsField(token))) return null;
  return NextResponse.json(
    { error: { code: 'forbidden', message: FIELD_READ_ONLY_MESSAGE } },
    { status: 403 },
  );
}
