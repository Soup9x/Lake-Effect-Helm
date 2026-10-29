import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { CategoryGrid, type CategoryRecord } from '@/components/shell/category-grid';
import { ViewHeader } from '@/components/shell/view-header';
import { AddVaultEntryButton, ImportVaultButton } from '@/components/personal-vault';
import { listVault } from '@/lib/personal/vault';

export const dynamic = 'force-dynamic';

/** What the list promises, and only that: the server holds the key. */
const VAULT_PROMISE =
  'Only you can see or open these, an administrator included. They belong to no client, never appear in ' +
  'client search or exports (the top bar’s My passwords search finds them, for you alone), and are deleted if you leave. Encrypted like every Helm secret; each time one is ' +
  'opened it is logged, without its name.';

/**
 * My passwords: the personal vault's list (1030), the same grid a client's
 * Credentials tab is — name, username, the OTP badge, open the website, search
 * and columns — and no values. Opening one is its page's business.
 *
 * DELETE, ONE OR MANY, AND NOTHING ELSE IN BULK. Rows are removeKind 'vault':
 * a row's Delete and the bulk bar's Delete (POST /api/bulk/delete) remove them
 * for good — the vault has no archive. Tag, archive, export and copy are an
 * entry's (asset_node's) actions, and these are not entries; nobody else can
 * open them, so there is no visibility to set either.
 */
export default async function MyPasswordsPage() {
  const identity = await getServerIdentity();
  // The owner policy returns this person's entries and nobody else's.
  const vault = await withTenant(actorOf(identity), (tx) => listVault(tx));

  const records = vault.map<CategoryRecord>((entry) => ({
    id: entry.id,
    name: entry.name,
    href: `/personal/passwords/${entry.id}`,
    secondary: entry.username,
    hasTotp: entry.hasTotp,
    externalUrl: entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null,
    updatedAt: entry.updatedAt,
    removeKind: 'vault',
    cells: { website: entry.url },
  }));

  return (
    <>
      <ViewHeader
        trail={[{ label: 'Personal', href: '/personal' }]}
        title="My passwords"
        description={VAULT_PROMISE}
        actions={<><ImportVaultButton /><AddVaultEntryButton /></>}
      />
      <CategoryGrid
        records={records}
        total={records.length}
        categoryLabel="Passwords"
        canWrite
        labels={{ secondary: 'Username' }}
        actorRoleRank={0}
        columnScope="personal-passwords"
        extraColumns={[{ key: 'website', header: 'Website' }]}
        // No type, category or other editor: an entry is one person's.
        omitColumns={['type', 'extra', 'updatedBy']}
        archivable={false}
        emptyMessage="Nothing stored yet. Add a password to keep it here, for you alone."
      />
    </>
  );
}
