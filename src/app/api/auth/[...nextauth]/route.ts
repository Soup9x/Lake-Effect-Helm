/**
 * Auth.js request handlers.
 *
 * Importing the config is what binds the session resolver that the rest of the
 * API layer uses (see lib/auth/session.ts), so this file is load-bearing beyond
 * serving the sign-in routes.
 *
 * A callback that belongs to a single sign-on re-authentication (1270) is
 * answered before Auth.js sees it: it arrives on the same registered redirect
 * URI as a sign-in, and finishSsoReauth() claims it only when its state matches
 * the encrypted cookie the re-authentication set. Everything else is Auth.js's.
 */
import type { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth/config';
import { finishSsoReauth } from '@/lib/auth/sso-reauth';

export async function GET(request: NextRequest): Promise<Response> {
  const reauth = await finishSsoReauth(request);
  if (reauth) return reauth;
  return handlers.GET(request);
}

export const { POST } = handlers;

export const dynamic = 'force-dynamic';
