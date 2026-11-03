import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, ShieldAlert } from 'lucide-react';
import { isUuid } from '@/lib/ids';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { recordView } from '@/lib/workspace/queries';
import { readFieldViewPolicy } from '@/lib/field/policy';
import { readFieldCredential } from '@/lib/field/queries';
import { RevealButton } from '@/components/reveal-button';
import { TotpPanel } from '@/components/totp-panel';
import { CopyValueButton } from '@/components/copy-value-button';
import { FieldCard, FieldValue, SensitivityBadge } from '../../ui';

/** On a phone a revealed password stays up for half the full site's time. */
const FIELD_AUTO_HIDE_MS = 30_000;

/**
 * One login in Field view. The password is shown LARGE: on site it is usually
 * read off the phone and typed into the client's machine. Every show and copy
 * goes through the same audited routes as the full site, marked "from phone".
 */
export default async function FieldCredentialPage({ params }: { params: Promise<{ nodeId: string }> }) {
  const identity = await getServerIdentity();
  const { nodeId } = await params;
  if (!isUuid(nodeId)) notFound();

  const data = await withTenant(actorOf(identity), async (tx) => {
    const credential = await readFieldCredential(tx, nodeId);
    if (!credential) return null;
    await recordView(tx, { nodeId });
    return { credential, policy: await readFieldViewPolicy(tx) };
  });
  if (!data) notFound();
  const { credential, policy } = data;
  const secret = credential.secret;
  const blocked = secret?.sensitivity === 'critical' && policy.criticalOnPhone === 'block';
  const website = credential.url && /^https?:\/\//i.test(credential.url) ? credential.url : null;

  return (
    <>
      <Link href={`/m/c/${credential.organizationId}?tab=logins`} className="px-1 text-sm text-brand">
        ‹ {credential.organizationName}
      </Link>
      <div className="flex items-start gap-2 px-1 pb-3 pt-1">
        <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight text-ink">{credential.name}</h1>
        <SensitivityBadge sensitivity={secret?.sensitivity ?? null} />
      </div>
      {credential.siteName && <p className="-mt-2 px-1 pb-3 text-sm text-ink-muted">{credential.siteName}</p>}

      <FieldCard>
        {credential.username && (
          <FieldValue
            label="Username"
            action={<CopyValueButton value={credential.username} label="Copy username" size="md" />}
          >
            <span className="font-mono">{credential.username}</span>
          </FieldValue>
        )}

        <div className="px-3.5 py-3">
          <div className="mb-1 text-xs text-ink-muted">Password</div>
          {!secret ? (
            <p className="text-sm text-ink-faint">No password stored.</p>
          ) : blocked ? (
            <p className="flex items-start gap-2 text-sm text-ink">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-sev-critical" aria-hidden />
              Critical credentials are not shown in Field view. Open it on a computer, or switch to the full site.
            </p>
          ) : !credential.canReveal ? (
            <p className="text-sm text-ink-faint">Your role cannot reveal passwords.</p>
          ) : (
            <RevealButton
              secretId={secret.id}
              label={credential.name}
              requiresReason={secret.requiresReason}
              requiresStepUp={secret.requiresStepUp}
              large
              autoHideMs={FIELD_AUTO_HIDE_MS}
            />
          )}
        </div>

        {credential.hasTotp && (
          <div className="px-3.5 py-3">
            <div className="mb-1 text-xs text-ink-muted">Verification code</div>
            <TotpPanel nodeId={credential.id} canReveal={credential.canReveal} />
          </div>
        )}

        {credential.url && (
          <FieldValue
            label="Address"
            action={
              website ? (
                <a
                  href={website}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open address"
                  className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand"
                >
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              ) : undefined
            }
          >
            <span className="break-all">{credential.url}</span>
          </FieldValue>
        )}

        {credential.notes && (
          <FieldValue label="Notes">
            <span className="whitespace-pre-wrap text-sm">{credential.notes}</span>
          </FieldValue>
        )}
      </FieldCard>

      <p className="mt-3 px-1 text-xs text-ink-faint">
        Every show and copy is recorded in the audit log as from Field view.
      </p>
    </>
  );
}
