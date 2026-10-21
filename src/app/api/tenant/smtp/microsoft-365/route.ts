import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { writeGraphEmail } from '@/lib/email/settings';

/**
 * Send Helm's mail through Microsoft 365 instead of the relay (1010).
 *
 * The connection is the MSP's own Microsoft 365 connection, made under
 * Administration → Integrations; helm.set_graph_email() refuses any other,
 * and checks tenant:write itself, as set_smtp_setting() does. Saving the relay
 * through PUT /api/tenant/smtp switches back.
 *
 * The sending address must be a mailbox in that tenant, a user or a shared
 * mailbox, and the app needs Mail.Send. Neither can be checked without
 * sending, so the first real send says — the same "proved by a real send"
 * rule the relay follows.
 */
const schema = z.object({
  enabled: z.boolean(),
  connectionId: z.guid(),
  fromAddress: z.string().trim().email().max(320),
  /** Empty means the sending address's own domain. See 0690's header. */
  allowedRecipientDomains: z.array(z.string().trim().min(1).max(253)).max(50).optional(),
});

export const PUT = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a Microsoft 365 connection and a sending mailbox', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });
    return writeGraphEmail(tx, body);
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
