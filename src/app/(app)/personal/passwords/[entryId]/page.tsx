import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Lock } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NotesCard } from '@/components/notes-card';
import { EditVaultEntryButton, VaultLoginRows } from '@/components/personal-vault';
import { getEntry } from '@/lib/personal/vault';
import { formatDateTime } from '@/lib/ui/format';

export const dynamic = 'force-dynamic';

/**
 * One personal vault entry, laid out as a client's credential is: its notes,
 * then a Credentials card of login rows with Edit details at its head.
 *
 * SOMEBODY ELSE'S ID IS A 404. The owner policy matches no row for anyone but
 * the owner, an administrator included, which reads exactly as an entry that
 * does not exist — and that is the answer, rather than a 403 that would
 * confirm there is something there.
 */
export default async function MyPasswordPage({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params;
  if (!z.guid().safeParse(entryId).success) notFound();

  const identity = await getServerIdentity();
  const entry = await withTenant(actorOf(identity), (tx) => getEntry(tx, entryId));
  if (!entry) notFound();

  return (
    <>
      <PageHeader
        title={entry.name}
        trail={[
          { label: 'Personal', href: '/personal' },
          { label: 'My passwords', href: '/personal/passwords' },
        ]}
      />
      <PageBody>
        <p className="flex items-center gap-1.5 text-xs text-ink-faint">
          <Lock className="size-3.5" aria-hidden />
          Private to you. Updated {formatDateTime(new Date(entry.updatedAt))}.
        </p>

        <NotesCard endpoint={`/api/personal/vault/${entry.id}`} notes={entry.notes} canEdit />

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Credentials</CardTitle>
            <EditVaultEntryButton entry={entry} />
          </CardHeader>
          <CardContent>
            <VaultLoginRows entry={entry} />
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
