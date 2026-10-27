import { getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { ExtensionPair } from '@/components/extension-pair';

export const dynamic = 'force-dynamic';

/**
 * Pairing the browser extension: the tab the extension opens, signed in as
 * the person approving it. See src/lib/extension/pairing-protocol.ts.
 *
 * The device's key arrives in the URL fragment, which only this page's script
 * reads, so the server renders the frame and the approval happens in the
 * client component.
 */
export default async function ExtensionPairPage() {
  const identity = await getServerIdentity();
  const membership = identity.memberships.find((m) => m.tenantId === identity.tenantId);

  return (
    <>
      <PageHeader
        title="Pair the browser extension"
        trail={[
          { label: 'Personal', href: '/personal' },
          { label: 'Browser extension', href: '/personal/browser-extension' },
        ]}
        description="Let the Helm extension in this browser look up and copy credentials as you."
      />
      <PageBody>
        <ExtensionPair
          tenantName={identity.tenantName}
          personName={identity.name || identity.email}
          allowed={membership?.orgScopeAll === true}
        />
      </PageBody>
    </>
  );
}
