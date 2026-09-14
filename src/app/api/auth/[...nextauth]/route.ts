/**
 * Auth.js request handlers.
 *
 * Importing the config is what binds the session resolver that the rest of the
 * API layer uses (see lib/auth/session.ts), so this file is load-bearing beyond
 * serving the sign-in routes.
 */
import { handlers } from '@/lib/auth/config';

export const { GET, POST } = handlers;

export const dynamic = 'force-dynamic';
