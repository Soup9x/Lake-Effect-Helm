import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const idSchema = z.guid();

/**
 * Put one synthetic notification on the queue.
 *
 * QUEUED, NOT SENT, and that is the point. A test that POSTed directly from
 * this request would prove the URL reachable from the web container and nothing
 * else — while the thing most likely to be broken is everything in between: the
 * worker running at all, the KEK opening the envelope, the format the platform
 * actually accepts.
 *
 * So it goes through the same path a real notification takes, and the settings
 * page reads the outcome out of the delivery log a moment later. The response
 * says so rather than showing a tick that means less than it looks like.
 */
export const POST = tenantRoute(
  async ({ tx, params }) => {
    const endpointId = idSchema.safeParse(params.endpointId);
    if (!endpointId.success) throw ApiError.invalid('invalid destination id');

    const [row] = await tx<{ send_test_notification: string }[]>`
      SELECT helm.send_test_notification(${endpointId.data}::uuid)
    `;

    return {
      queued: true,
      eventUid: row?.send_test_notification ?? null,
      message:
        'Queued. The notification worker picks it up within a minute and the result ' +
        'appears in the delivery log below — including the platform’s own error if it ' +
        'refuses the payload.',
    };
  },
  { permissions: ['integration:manage'] },
);

export const dynamic = 'force-dynamic';
