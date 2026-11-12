'use client';

/**
 * Tells zod not to probe for eval in the browser.
 *
 * zod speeds up parsing by compiling validators with `new Function`, and finds
 * out whether it may by trying once and catching the refusal. Helm's Content
 * Security Policy refuses (lib/ui/csp.ts), which is the point of it, and zod
 * falls back correctly, but the browser still reports the attempt as a policy
 * violation in the console of any page that validates a form. `jitless` skips
 * the attempt. Browser only: the server has no such policy and keeps the fast
 * path.
 */
import { config } from 'zod';

if (typeof window !== 'undefined') config({ jitless: true });

export function CspClient(): null {
  return null;
}
