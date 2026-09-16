/**
 * POST /api/auth/local/logout — end this session.
 *
 * Deletes the auth_session row and THEN clears the cookie, in that order. The
 * reverse would leave a live row behind a cleared cookie, which is a session
 * that anybody who copied the cookie still holds — a sign-out that does not
 * sign anything out.
 *
 * Works for an SSO session too: there is only one kind of session.
 */
import { NextResponse } from 'next/server';
import { publicRoute } from '@/lib/api/handler';
import { clearSessionCookie, sessionCookieName } from '@/lib/auth/session-cookie';
import { db } from '@/lib/db/client';

export const POST = publicRoute(async (request) => {
  const token = request.cookies.get(sessionCookieName())?.value;

  if (token) {
    await db('auth')`DELETE FROM auth_session WHERE session_token = ${token}`;
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
});

export const dynamic = 'force-dynamic';
