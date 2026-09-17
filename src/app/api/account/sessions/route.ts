import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { sessionCookieName, sessionRef } from '@/lib/auth/session-cookie';

/**
 * Ending your own sessions.
 *
 * helm_app cannot touch auth_session — §21 of the security model, and 0360
 * re-asserts it. So both operations go through SECURITY DEFINER functions that
 * resolve the owner from the session context, which means a reference belonging
 * to somebody else simply matches no row. The caller cannot name another
 * person's session because the caller's identity is never taken from the
 * request body.
 *
 * `others` needs to know which session is the current one, and derives it from
 * this request's own cookie rather than being told. A caller-supplied "keep
 * this one" would let a stolen cookie sign the real owner out of everything
 * while keeping itself alive — turning a revocation feature into an eviction
 * tool for whoever is holding the stolen session.
 */
const bodySchema = z.union([
  z.object({ ref: z.string().regex(/^[0-9a-f]{32}$/) }),
  z.object({ others: z.literal(true) }),
]);

export const POST = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = bodySchema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('send either a session ref or { "others": true }');
    }
    return result.data;
  });

  if ('others' in body) {
    const token = request.cookies.get(sessionCookieName())?.value;
    if (!token) {
      // Belt and braces: tenantRoute already authenticated this request, so a
      // missing cookie here means an API token is driving it. Signing a person
      // out of everything "except the session making the call" is meaningless
      // when the caller holds no session, and would end every one of them.
      throw ApiError.invalid('this operation is only available from a signed-in browser');
    }

    const [result] = await tx<{ revoke_my_other_sessions: number }[]>`
      SELECT helm.revoke_my_other_sessions(${sessionRef(token)})
    `;
    return { ended: result?.revoke_my_other_sessions ?? 0 };
  }

  const [result] = await tx<{ revoke_my_session: boolean }[]>`
    SELECT helm.revoke_my_session(${body.ref})
  `;

  if (!result?.revoke_my_session) {
    // Indistinguishable from "that ref belongs to somebody else", which is the
    // point: the answer must not confirm that a ref names a real session.
    throw ApiError.notFound('no such session');
  }

  return { ended: 1 };
});

export const dynamic = 'force-dynamic';
