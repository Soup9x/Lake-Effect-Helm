import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { authenticate } from '@/lib/auth/radius';
import { radiusForTenant, recordRadiusTest } from '@/lib/auth/radius-config';

/**
 * Prove the configuration works, before somebody's sign-in depends on it.
 *
 * Two tests, because there are two different things that can be wrong and they
 * fail in ways that look identical from a settings page:
 *
 *   connection      Does a server answer at that address, and does it hold the
 *                   same shared secret? Sent as an Access-Request for an
 *                   account that cannot exist. The expected answer is
 *                   Access-Reject, and that is a PASS: a reject is a signed
 *                   reply, and only the holder of the shared secret can sign
 *                   one. What fails is silence (unreachable, or the server does
 *                   not recognise this NAS) or a reply that does not verify
 *                   (the secret does not match).
 *
 *   authentication  Somebody's real credentials, end to end. The only way to
 *                   find out whether the server's policy actually lets Helm
 *                   users in, which a reject for a nonexistent account cannot
 *                   tell you.
 *
 * Runs on the auth pool, because that is the only role that can read the shared
 * secret — the same boundary the sign-in path itself crosses. Authorisation
 * happened before we got here: tenantRoute checked tenant:write against the
 * database's own answer.
 *
 * A NOTE FOR OPERATORS, surfaced in the UI: the connection test produces a
 * failed authentication in the RADIUS server's log, because that is exactly
 * what it is. On a server with alerting on failed logins, expect one.
 */
const testSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('connection') }),
  z.object({
    mode: z.literal('authentication'),
    username: z.string().trim().min(1).max(253),
    password: z.string().min(1).max(128),
  }),
]);

export const POST = tenantRoute(
  async ({ request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = testSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('say whether to test the connection or an authentication');
      }
      return result.data;
    });

    const resolved = await radiusForTenant(session.tenantId);
    if (!resolved) {
      throw ApiError.notFound('RADIUS is not configured for this tenant');
    }

    const username =
      body.mode === 'connection'
        ? // Random, so it cannot collide with a real account and cannot be
          // used to check whether a particular name exists in the directory.
          `helm-probe-${randomBytes(9).toString('hex')}`
        : body.username;
    const password = body.mode === 'connection' ? randomBytes(24).toString('base64url') : body.password;

    const result = await authenticate(resolved.server, username, password);

    // What counts as a pass depends on which test ran. For the connection test
    // a reject is the expected result and proves everything it set out to; for
    // an authentication test a reject is a genuine failure.
    const ok =
      body.mode === 'connection'
        ? result.outcome === 'reject' || result.outcome === 'accept' || result.outcome === 'challenge'
        : result.outcome === 'accept';

    const summary = describe(body.mode, result, ok);
    await recordRadiusTest(session.tenantId, ok, ok ? undefined : summary);

    return {
      ok,
      outcome: result.outcome,
      message: summary,
      // Server-supplied text, rendered as text. Useful for an MFA prompt
      // ("Approve the push notification") or a policy refusal.
      replyMessage: 'replyMessage' in result ? (result.replyMessage ?? null) : null,
    };
  },
  { permissions: ['tenant:write'] },
);

function describe(
  mode: 'connection' | 'authentication',
  result: Awaited<ReturnType<typeof authenticate>>,
  ok: boolean,
): string {
  if (ok && mode === 'connection') {
    return result.outcome === 'reject'
      ? 'The server answered and its reply verified against the shared secret. ' +
          'It rejected the throwaway account the test used, which is the expected answer.'
      : 'The server answered and its reply verified against the shared secret.';
  }
  if (ok) return 'Those credentials were accepted.';

  switch (result.outcome) {
    case 'reject':
      return 'The server rejected those credentials.';
    case 'challenge':
      return (
        'The server asked for a second factor. Helm signs in on one round, so an ' +
        'account that requires an interactive challenge cannot complete here — ' +
        'configure the server to accept a push or an appended one-time code instead.'
      );
    case 'timeout':
      return (
        `${result.message}. Either nothing is listening, a firewall is dropping UDP, ` +
        'or the server does not recognise this Helm host as a NAS client.'
      );
    case 'bad_secret':
    case 'error':
      return result.message;
    case 'accept':
      // Unreachable: an accept is a pass for both modes, so `ok` was true and
      // this function returned above. Named rather than left to `default` so
      // that a new outcome added to RadiusOutcome fails the build here instead
      // of quietly falling into a branch that reads a field it may not have.
      return 'The server accepted.';
  }
}

export const dynamic = 'force-dynamic';
