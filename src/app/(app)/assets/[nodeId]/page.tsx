import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Network } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { AssetForm } from '@/components/asset-form';
import { DependencyEditor, RemoveDependency, relationPhrase } from '@/components/dependency-editor';
import { isClientRole } from '@/lib/ui/roles';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, severityTone } from '@/components/ui/badge';
import { RevealButton } from '@/components/reveal-button';
import { formatDate, formatDateTime, humanise } from '@/lib/ui/format';
import { recordView } from '@/lib/workspace/queries';
import { NotesCard } from '@/components/notes-card';

interface NodeRow {
  id: string; node_type: string; name: string; description: string | null;
  notes: string | null;
  status: string; tags: string[]; criticality: number;
  organization_id: string; organization_name: string;
  site_id: string | null; is_internal_only: boolean;
  site_name: string | null; updated_at: Date;
}

interface EdgeRow {
  from_node_id: string; to_node_id: string; relation: string; direction: string;
  origin: string; other_id: string; other_name: string; other_type: string;
}

interface SecretRow {
  id: string; label: string; kind: string; sensitivity: string;
  requires_reason: boolean; requires_step_up: boolean;
  strength_score: number | null; last_rotated_at: Date | null; rotation_due_at: Date | null;
}

interface ExpiryRow {
  id: string; kind: string; label: string; expires_at: Date; severity: string;
}

/**
 * One asset, its details, its dependencies and its credentials.
 *
 * The relationship list is the reason this page exists. "What breaks if I take
 * this offline" is answered by the graph, not by a description field somebody
 * wrote in 2021 — so intrinsic edges (a device's primary network, a
 * certificate's domain) appear here alongside the ones a technician drew, and
 * each is labelled with where it came from.
 */
export default async function AssetPage({ params }: { params: Promise<{ nodeId: string }> }) {
  const identity = await getServerIdentity();
  const { nodeId } = await params;

  const data = await withTenant(actorOf(identity), async (tx) => {
    const [node] = await tx<NodeRow[]>`
      SELECT n.id, n.node_type::text, n.name, n.description, n.notes, n.status::text,
             n.tags, n.criticality, n.organization_id, o.name AS organization_name,
             n.site_id, n.is_internal_only,
             s.name AS site_name, n.updated_at
      FROM asset_node n
      JOIN organization o ON o.id = n.organization_id
      LEFT JOIN site s ON s.id = n.site_id
      WHERE n.id = ${nodeId}::uuid AND n.archived_at IS NULL
    `;
    if (!node) return null;

    // After the node has been proven readable, so an id RLS refuses never
    // appears in somebody's recent list.
    await recordView(tx, { nodeId });

    const [detailRows, edges, secrets, expiries] = await Promise.all([
      // The subtype row, as a flat object. The table name is derived from the
      // node_type enum, never from user input.
      detailFor(tx, node.node_type, node.id),
      /*
       * FROM THIS NODE ONLY, and that is the fix for a real bug rather than a
       * narrowing.
       *
       * v_asset_edge emits every stored edge TWICE — once each way, with the
       * relation inverted on the reverse pass — so that a caller can ask the
       * question from either end. This query used to match `from = me OR to =
       * me`, which matches both copies of every edge involving this node. One
       * link therefore rendered as two rows saying opposite things: "member_of
       * VLAN 10" directly above "contains VLAN 10".
       *
       * Asking only for rows where this node is the source gives each
       * relationship exactly once, already expressed from this node's point of
       * view, because the view has done the inverting.
       */
      tx<EdgeRow[]>`
        SELECT e.from_node_id, e.to_node_id, e.relation::text, e.direction::text, e.origin::text,
               other.id AS other_id, other.name AS other_name, other.node_type::text AS other_type
        FROM v_asset_edge e
        JOIN asset_node other ON other.id = e.to_node_id
        WHERE e.from_node_id = ${nodeId}::uuid
        ORDER BY e.relation, other.name
      `,
      tx<SecretRow[]>`
        SELECT m.id, m.label, m.kind::text, m.sensitivity::text, m.requires_reason,
               m.requires_step_up, m.strength_score, m.last_rotated_at, m.rotation_due_at
        FROM v_secret_metadata m
        WHERE m.id IN (
          SELECT c.secret_id FROM credential c WHERE c.id = ${nodeId}::uuid AND c.secret_id IS NOT NULL
          UNION
          SELECT c.totp_secret_id FROM credential c WHERE c.id = ${nodeId}::uuid AND c.totp_secret_id IS NOT NULL
          UNION
          SELECT s.private_key_secret_id FROM ssl_certificate s
            WHERE s.id = ${nodeId}::uuid AND s.private_key_secret_id IS NOT NULL
        )
      `,
      tx<ExpiryRow[]>`
        SELECT id, kind::text, label, expires_at, severity::text
        FROM v_expiration_dashboard WHERE node_id = ${nodeId}::uuid ORDER BY expires_at
      `,
    ]);

    // The client's other sites, for the edit form's picker. Read through RLS,
    // so it can only ever offer sites this actor may already see.
    const sites = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM site
      WHERE organization_id = ${node.organization_id}::uuid AND deleted_at IS NULL
      ORDER BY name
    `;

    return { node, detail: detailRows, edges, secrets, expiries, sites };
  });

  if (!data) notFound();
  const { node, detail, edges, secrets, expiries, sites } = data;
  const canWrite = !isClientRole(identity.roleKey);

  return (
    <>
      <PageHeader
        title={node.name}
        description={node.description ?? undefined}
        // The site is a crumb without a link: it is genuinely where this asset
        // sits, and it has no page of its own to go to.
        trail={[
          { label: 'Clients', href: '/organizations' },
          { label: node.organization_name, href: `/organizations/${node.organization_id}` },
          ...(node.site_name ? [{ label: node.site_name }] : []),
        ]}
        actions={
          <AssetForm
            nodeId={node.id}
            canEdit={canWrite}
            sites={sites}
            values={{
              name: node.name,
              description: node.description ?? '',
              status: node.status,
              criticality: node.criticality,
              siteId: node.site_id ?? '',
              isInternalOnly: node.is_internal_only,
              tags: node.tags,
            }}
          />
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand">{humanise(node.node_type)}</Badge>
          <Badge tone={node.status === 'active' ? 'ok' : 'neutral'}>{node.status}</Badge>
          <Badge tone={node.criticality >= 4 ? 'critical' : 'neutral'}>
            Criticality {node.criticality}
          </Badge>
          {node.site_name && <Badge tone="neutral">{node.site_name}</Badge>}
          {node.tags.map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
          {expiries.map((expiry) => (
            <Badge key={expiry.id} tone={severityTone(expiry.severity)}>
              {humanise(expiry.kind)} {formatDate(expiry.expires_at)}
            </Badge>
          ))}
        </div>

        {/* A credential's notes land here too: a credential IS an asset_node,
            and 0370 made that the one place notes live for any of them. */}
        <NotesCard
          endpoint={`/api/assets/${node.id}`}
          notes={node.notes}
          canEdit={canWrite}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(detail).length === 0 ? (
                <p className="text-sm text-ink-faint">No type-specific detail recorded.</p>
              ) : (
                <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
                  {Object.entries(detail).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="truncate text-ink-muted">{humanise(key)}</dt>
                      <dd className="min-w-0 break-words text-ink">{renderValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <p className="mt-4 text-xs text-ink-faint">
                Last updated {formatDateTime(node.updated_at)}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Network className="size-4 text-ink-faint" aria-hidden /> Dependencies
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {edges.length === 0 ? (
                <p className="text-sm text-ink-faint">
                  Nothing is linked to this asset yet. Links are what make an impact assessment
                  possible.
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {edges.map((edge) => (
                    <li
                      key={`${edge.relation}:${edge.other_id}`}
                      className="flex items-center gap-2"
                    >
                      {/*
                        Phrased rather than humanised: "is secured by" reads as
                        a sentence about this asset, where "Secured by" reads as
                        a column heading.
                      */}
                      <span className="shrink-0 text-ink-muted">{relationPhrase(edge.relation)}</span>
                      <Link href={`/assets/${edge.other_id}`} className="truncate text-brand hover:underline">
                        {edge.other_name}
                      </Link>
                      <Badge tone="neutral">{humanise(edge.other_type)}</Badge>
                      {edge.origin !== 'manual' && <Badge tone="brand">{edge.origin}</Badge>}
                      {/*
                        Only a manual edge has a row to delete. An intrinsic one
                        is projected from a foreign key, so removing it means
                        editing the asset, not unlinking it.
                      */}
                      {edge.origin === 'manual' && canWrite && (
                        <span className="ml-auto">
                          <RemoveDependency
                            sourceNodeId={node.id}
                            relation={edge.relation}
                            targetNodeId={edge.other_id}
                          />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <DependencyEditor
                nodeId={node.id}
                organizationId={node.organization_id}
                canLink={canWrite}
              />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Credentials</CardTitle>
          </CardHeader>
          <CardContent className={secrets.length === 0 ? 'p-0' : 'space-y-5'}>
            {secrets.length === 0 ? (
              <EmptyState title="No credentials attached to this asset" />
            ) : (
              secrets.map((secret) => (
                <div key={secret.id} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{secret.label}</span>
                    <Badge tone="neutral">{humanise(secret.kind)}</Badge>
                    <Badge
                      tone={
                        secret.sensitivity === 'critical'
                          ? 'critical'
                          : secret.sensitivity === 'elevated'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {secret.sensitivity}
                    </Badge>
                    {secret.requires_step_up && <Badge tone="warning">Step-up required</Badge>}
                    {secret.strength_score !== null && secret.strength_score < 50 && (
                      <Badge tone="warning">Weak ({secret.strength_score})</Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-faint">
                    Last rotated {formatDate(secret.last_rotated_at)}
                    {secret.rotation_due_at && ` · due ${formatDate(secret.rotation_due_at)}`}
                  </p>
                  <RevealButton
                    secretId={secret.id}
                    label={secret.label}
                    requiresReason={secret.requires_reason}
                    requiresStepUp={secret.requires_step_up}
                  />
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

/** node_type is a database enum, so the table name can never come from input. */
const DETAIL_TABLES: ReadonlyMap<string, string> = new Map([
  ['device', 'device'],
  ['network', 'network'],
  ['ip_address', 'ip_address'],
  ['domain', 'domain'],
  ['ssl_certificate', 'ssl_certificate'],
  ['application', 'application'],
  ['directory_service', 'directory_service'],
  ['contract', 'contract'],
  ['license', 'license'],
  ['isp_circuit', 'isp_circuit'],
  ['vendor', 'vendor'],
]);

async function detailFor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  nodeType: string,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const table = DETAIL_TABLES.get(nodeType);
  if (!table) return {};

  const rows = await tx<{ row: Record<string, unknown> }[]>`
    SELECT to_jsonb(t) - 'id' - 'tenant_id' - 'node_type' AS row
    FROM ${tx(table)} t WHERE t.id = ${nodeId}::uuid
  `;

  const row = rows[0]?.row ?? {};
  // Secret *references* are shown elsewhere as a reveal control; listing the id
  // as a detail field is noise, and inviting someone to copy it is worse.
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key, value]) => value !== null && value !== '' && !key.endsWith('_secret_id'),
    ),
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
