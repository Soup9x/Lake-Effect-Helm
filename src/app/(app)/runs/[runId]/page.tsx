import { notFound } from 'next/navigation';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { ChecklistRun } from '@/components/checklist-run';
import { listAssignableUsers, readRun } from '@/lib/sops/queries';

export const dynamic = 'force-dynamic';

/**
 * One checklist run.
 *
 * NOT UNDER /organizations/[id], and that is deliberate. A run belongs to a
 * client, but it is worked on as a task — somebody opens it from their list,
 * works down it, and closes it — so it is reached by its own id and carries a
 * trail back to the client rather than living inside that client's drawer. It
 * is also what F2's My Tasks will link to, from a page that spans clients.
 *
 * The status, the version it froze and who started it are all on the page
 * because a run IS the evidence: six months later the question is "which steps
 * did we complete, and what did the procedure say at the time", and the answer
 * has to be legible without a database.
 *
 * The assignable list is fetched only for somebody who may execute, because it
 * exists to fill a picker they will not be shown otherwise — and it is a list
 * of colleagues' names, which is not something to hand to a client-side role
 * for no reason.
 */
export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const identity = await getServerIdentity();
  const { runId } = await params;

  const data = await withTenant(actorOf(identity), async (tx) => {
    const run = await readRun(tx, runId);
    if (!run) return null;

    // Mirrors the routes' gate, so the controls are only offered to somebody
    // they would work for. The route and the policy both check again.
    const [perm] = await tx<{ allowed: boolean }[]>`
      SELECT helm.has_permission('sop:execute') AS allowed
    `;
    const canExecute = perm?.allowed ?? false;
    const assignable = canExecute ? await listAssignableUsers(tx) : [];
    return { run, canExecute, assignable };
  });

  if (!data) notFound();
  const { run, canExecute, assignable } = data;

  return (
    <>
      <PageHeader
        title={run.title}
        description={`${run.sopName} · v${run.version}`}
        trail={[
          { label: 'Clients', href: '/organizations' },
          { label: run.organizationName, href: `/organizations/${run.organizationId}` },
        ]}
      />
      <PageBody>
        <ChecklistRun run={run} canExecute={canExecute} assignable={assignable} />
      </PageBody>
    </>
  );
}
