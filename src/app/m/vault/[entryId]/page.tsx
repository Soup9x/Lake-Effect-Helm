import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ExternalLink } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { getEntry } from '@/lib/personal/vault';
import { readFieldViewPolicy } from '@/lib/field/policy';
import { RevealButton } from '@/components/reveal-button';
import { TotpPanel } from '@/components/totp-panel';
import { CopyValueButton } from '@/components/copy-value-button';
import { FieldCard, FieldValue } from '../../ui';

/** One entry of your own vault, in Field view. */
export default async function FieldVaultEntry({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params;
  if (!z.guid().safeParse(entryId).success) notFound();
  const identity = await getServerIdentity();
  const entry = await withTenant(actorOf(identity), async (tx) => {
    if (!(await readFieldViewPolicy(tx)).sections.includes('vault')) return null;
    return getEntry(tx, entryId);
  });
  if (!entry) notFound();
  const base = `/api/personal/vault/${entry.id}`;
  const website = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null;

  return (
    <>
      <Link href="/m/vault" className="px-1 text-sm text-brand">‹ My vault</Link>
      <h1 className="px-1 pb-3 pt-1 text-xl font-semibold tracking-tight text-ink">{entry.name}</h1>
      <FieldCard>
        {entry.username && (
          <FieldValue label="Username" action={<CopyValueButton value={entry.username} label="Copy username" size="md" />}>
            <span className="font-mono">{entry.username}</span>
          </FieldValue>
        )}
        <div className="px-3.5 py-3">
          <div className="mb-1 text-xs text-ink-muted">Password</div>
          {entry.hasPassword ? (
            <RevealButton
              secretId={entry.id}
              label={entry.name}
              requiresReason={false}
              requiresStepUp={false}
              endpoints={{ reveal: `${base}/reveal` }}
              large
              autoHideMs={30_000}
            />
          ) : (
            <p className="text-sm text-ink-faint">No password stored.</p>
          )}
        </div>
        {entry.hasTotp && (
          <div className="px-3.5 py-3">
            <div className="mb-1 text-xs text-ink-muted">Verification code</div>
            <TotpPanel nodeId={entry.id} canReveal codePath={`${base}/code`} />
          </div>
        )}
        {entry.url && (
          <FieldValue
            label="Address"
            action={website ? (
              <a href={website} target="_blank" rel="noopener noreferrer" aria-label="Open address"
                 className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand">
                <ExternalLink className="size-4" aria-hidden />
              </a>
            ) : undefined}
          >
            <span className="break-all">{entry.url}</span>
          </FieldValue>
        )}
        {entry.notes && (
          <FieldValue label="Notes"><span className="whitespace-pre-wrap text-sm">{entry.notes}</span></FieldValue>
        )}
      </FieldCard>
    </>
  );
}
