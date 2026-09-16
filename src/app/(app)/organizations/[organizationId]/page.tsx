import Link from 'next/link';
import { notFound } from 'next/navigation';
import { KeyRound, MapPin, Users } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { NewSecretForm } from '@/components/new-secret-form';
import { NewSiteForm } from '@/components/new-site-form';
import { NewAssetForm } from '@/components/new-asset-form';
import { RenameOrganization } from '@/components/rename-organization';
import { isClientRole } from '@/lib/ui/roles';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, severityTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RevealButton } from '@/components/reveal-button';
import { formatDate, humanise, relativeDays } from '@/lib/ui/format';

interface OrgRow {
  id: string; name: string; legal_name: string | null; status: string;
  industry: string | null; employee_count: number | null; timezone: string | null;
  website: string | null; onboarded_at: Date | null;
}

interface SiteRow {
  id: string; name: string; is_primary: boolean; address_line1: string | null;
  city: string | null; region: string | null; main_phone: string | null;
}

interface ContactRow {
  id: string; first_name: string; last_name: string | null; title: string | null;
  email: string | null; phone: string | null; is_primary: boolean; is_emergency: boolean;
}

interface AssetRow {
  id: string; node_type: string; name: string; status: string; criticality: number;
}

interface CredentialRow {
  node_id: string; name: string; credential_type: string; username: string | null;
  url: string | null; secret_id: string | null; sensitivity: string | null;
  requires_reason: boolean; requires_step_up: boolean; is_break_glass: boolean;
  strength_score: number | null;
}

interface ExpiryRow {
  id: string; label: string; kind: string; expires_at: Date; severity: string; days_remaining: number;
}

/**
 * One client, everything Helm knows about them.
 *
 * Six queries rather than one join: they are independent lists with different
 * cardinalities, and a single query would fan out the credential rows across
 * every asset. Each is RLS-scoped in its own right, so an organisation the
 * actor cannot see produces `notFound()` at the first query rather than an
 * empty page that looks like a data problem.
 */
export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const identity = await getServerIdentity();
  const { organizationId } = await params;

  const data = await withTenant(actorOf(identity), async (tx) => {
    const [organization] = await tx<OrgRow[]>`
      SELECT id, name, legal_name, status::text, industry, employee_count,
             timezone, website, onboarded_at
      FROM organization WHERE id = ${organizationId}::uuid AND deleted_at IS NULL
    `;
    if (!organization) return null;

    const [sites, contacts, assets, credentials, expiries] = await Promise.all([
      tx<SiteRow[]>`
        SELECT id, name, is_primary, address_line1, city, region, main_phone
        FROM site WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        ORDER BY is_primary DESC, name
      `,
      tx<ContactRow[]>`
        SELECT id, first_name, last_name, title, email::text, phone, is_primary, is_emergency
        FROM contact WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        ORDER BY is_primary DESC, last_name NULLS LAST, first_name
      `,
      tx<AssetRow[]>`
        SELECT id, node_type::text, name, status::text, criticality
        FROM asset_node
        WHERE organization_id = ${organizationId}::uuid AND archived_at IS NULL
          AND node_type <> 'credential'
        ORDER BY criticality DESC, node_type, name
        LIMIT 300
      `,
      tx<CredentialRow[]>`
        SELECT n.id AS node_id, n.name, c.credential_type::text, c.username::text, c.url,
               c.secret_id::text, c.is_break_glass,
               m.sensitivity::text, m.requires_reason, m.requires_step_up, m.strength_score
        FROM credential c
        JOIN asset_node n ON n.id = c.id
        LEFT JOIN v_secret_metadata m ON m.id = c.secret_id
        WHERE n.organization_id = ${organizationId}::uuid AND n.archived_at IS NULL
        ORDER BY n.name
      `,
      tx<ExpiryRow[]>`
        SELECT id, label, kind::text, expires_at, severity::text, days_remaining
        FROM v_expiration_dashboard
        WHERE organization_id = ${organizationId}::uuid
        ORDER BY expires_at LIMIT 25
      `,
    ]);

    return { organization, sites, contacts, assets, credentials, expiries };
  });

  // RLS makes "not yours" and "not there" the same answer; so does this page.
  if (!data) notFound();

  const { organization, sites, contacts, assets, credentials, expiries } = data;
  const canWrite = !isClientRole(identity.roleKey);

  return (
    <>
      <PageHeader
        title={organization.name}
        description={
          [organization.legal_name, organization.industry, organization.timezone]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        actions={
          <div className="flex items-center gap-2">
            {canWrite && (
              <RenameOrganization
                organizationId={organization.id}
                currentName={organization.name}
              />
            )}
            <Button asChild variant="secondary" size="sm">
              <Link href={`/exports?organizationId=${organization.id}`}>Export documentation</Link>
            </Button>
          </div>
        }
      />
      <PageBody>
        {canWrite && (
          <div className="mb-4 flex flex-wrap gap-2">
            <NewSecretForm organizationId={organization.id} />
            <NewSiteForm organizationId={organization.id} />
            <NewAssetForm
              organizationId={organization.id}
              sites={sites.map((s) => ({ id: s.id, name: s.name }))}
            />
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="size-4 text-ink-faint" aria-hidden /> Sites
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {sites.length === 0 && <p className="text-ink-faint">No sites documented.</p>}
              {sites.map((site) => (
                <div key={site.id}>
                  <div className="font-medium text-ink">
                    {site.name}
                    {site.is_primary && <Badge tone="brand" className="ml-2">Primary</Badge>}
                  </div>
                  <div className="text-ink-muted">
                    {[site.address_line1, site.city, site.region].filter(Boolean).join(', ') || '—'}
                  </div>
                  {site.main_phone && <div className="text-ink-faint">{site.main_phone}</div>}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="size-4 text-ink-faint" aria-hidden /> Contacts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {contacts.length === 0 && <p className="text-ink-faint">No contacts documented.</p>}
              {contacts.map((contact) => (
                <div key={contact.id}>
                  <div className="font-medium text-ink">
                    {contact.first_name} {contact.last_name}
                    {contact.is_emergency && (
                      <Badge tone="critical" className="ml-2">Emergency</Badge>
                    )}
                  </div>
                  <div className="text-ink-muted">{contact.title ?? '—'}</div>
                  <div className="text-ink-faint">
                    {[contact.email, contact.phone].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Expiring</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {expiries.length === 0 && <p className="text-ink-faint">Nothing tracked.</p>}
              {expiries.map((expiry) => (
                <div key={expiry.id} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-ink">{expiry.label}</div>
                    <div className="text-xs text-ink-faint">
                      {humanise(expiry.kind)} · {formatDate(expiry.expires_at)} (
                      {relativeDays(expiry.days_remaining)})
                    </div>
                  </div>
                  <Badge tone={severityTone(expiry.severity)}>{expiry.severity}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-ink-faint" aria-hidden /> Credentials
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {credentials.length === 0 ? (
              <EmptyState
                icon={KeyRound}
                title="No credentials documented"
                description="Credentials stored here are encrypted per tenant and every read is recorded."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Credential</TableHead>
                    <TableHead>Username</TableHead>
                    <TableHead>Sensitivity</TableHead>
                    <TableHead className="w-96">Secret</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {credentials.map((credential) => (
                    <TableRow key={credential.node_id} className="hover:bg-transparent">
                      <TableCell>
                        <Link
                          href={`/assets/${credential.node_id}`}
                          className="font-medium text-ink hover:text-brand"
                        >
                          {credential.name}
                        </Link>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className="text-xs text-ink-faint">
                            {humanise(credential.credential_type)}
                          </span>
                          {credential.is_break_glass && <Badge tone="critical">Break glass</Badge>}
                          {credential.strength_score !== null && credential.strength_score < 50 && (
                            <Badge tone="warning">Weak</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-ink-muted">
                        {credential.username ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          tone={
                            credential.sensitivity === 'critical'
                              ? 'critical'
                              : credential.sensitivity === 'elevated'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {credential.sensitivity ?? 'unknown'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {credential.secret_id ? (
                          <RevealButton
                            secretId={credential.secret_id}
                            label={credential.name}
                            requiresReason={credential.requires_reason}
                            requiresStepUp={credential.requires_step_up}
                          />
                        ) : (
                          <span className="text-xs text-ink-faint">No stored secret</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Assets</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {assets.length === 0 ? (
              <EmptyState title="No assets documented" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Criticality</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assets.map((asset) => (
                    <TableRow key={asset.id}>
                      <TableCell>
                        <Link href={`/assets/${asset.id}`} className="font-medium hover:text-brand">
                          {asset.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-ink-muted">{humanise(asset.node_type)}</TableCell>
                      <TableCell className="text-ink-muted">{asset.status}</TableCell>
                      <TableCell className="tabular-nums text-ink-muted">
                        {asset.criticality}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
