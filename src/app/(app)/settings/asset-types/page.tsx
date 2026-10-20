import { Boxes, Plus } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { FlexibleTypeEditor, type EditableType } from '@/components/flexible-type-editor';
import { schemaToFields } from '@/lib/flexible/fields';
import { formatDateTime } from '@/lib/ui/format';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  colour: string | null;
  is_active: boolean;
  client_visible: boolean;
  version: number | null;
  json_schema: unknown;
  ui_schema: unknown;
  searchable_fields: string[] | null;
  secret_fields: string[] | null;
  updated_at: Date;
  record_count: string;
  needs_migration_count: string;
}

/**
 * The tenant's own asset types — the screen the documentation model never had.
 *
 * Everything under here has existed since 0080: a type, immutable published
 * schema versions, records validated against them, `x-helm-secret` fields split
 * out and encrypted. The only missing piece was a way to define one without
 * writing JSON Schema by hand or inserting a row, which in practice meant only
 * the person who wrote the API ever created a type.
 *
 * ONE QUERY, with the schema, because the editor needs it to open — the field
 * list is decoded here in the server component so the client bundle carries the
 * conversion once rather than per type. The per-type GET route exists for the
 * same purpose from other callers; this page already has the rows.
 *
 * `needsMigration` is counted per type because it is the number that matters
 * when deciding whether to publish again, and until this group nothing ever
 * set the flag it counts.
 */
export default async function AssetTypesPage() {
  const identity = await getServerIdentity();

  const { types, canManage } = await withTenant(actorOf(identity), async (tx, session) => {
    const rows = await tx<Row[]>`
      SELECT t.id, t.key, t.name, t.description, t.icon, t.colour,
             t.is_active, t.client_visible, t.updated_at,
             v.version, v.json_schema, v.ui_schema,
             v.searchable_fields, v.secret_fields,
             (SELECT count(*) FROM flexible_asset_record r WHERE r.type_id = t.id)
               AS record_count,
             (SELECT count(*) FROM flexible_asset_record r
               WHERE r.type_id = t.id AND r.needs_migration) AS needs_migration_count
      FROM flexible_asset_type t
      LEFT JOIN flexible_asset_type_version v ON v.id = t.current_version_id
      ORDER BY t.name
    `;
    return {
      types: rows,
      canManage: session.permissions.includes('flexible_type:manage'),
    };
  });

  const editable = (row: Row): EditableType => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    icon: row.icon,
    colour: row.colour,
    clientVisible: row.client_visible,
    currentVersion: row.version,
    fields: schemaToFields(row.json_schema, row.ui_schema),
    searchableFields: row.searchable_fields ?? [],
    recordCount: Number(row.record_count),
  });

  return (
    <>
      <PageHeader
        title="Asset types"
        trail={[{ label: 'Administration', href: '/settings' }]}
        description="The documentation types this tenant defines for itself, beyond Helm's built-in ones. Each publishes an immutable schema version that records are validated against."
        actions={
          canManage ? (
            <FlexibleTypeEditor
              trigger={
                <Button variant="cta" size="sm">
                  <Plus className="size-3.5" aria-hidden /> New type
                </Button>
              }
            />
          ) : undefined
        }
      />
      <PageBody>
        <AdminNav />
        <Card>
          <CardContent className="p-0">
            {types.length === 0 ? (
              <EmptyState
                icon={Boxes}
                title="No custom types yet"
                description={
                  canManage
                    ? 'A type defines the fields a record has — a Microsoft 365 tenant, a backup job, a line-of-business application.'
                    : 'Defining a type needs the schema permission.'
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Type</TableHead>
                    <TableHead>Fields</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Records</TableHead>
                    <TableHead>Visibility</TableHead>
                    <TableHead>Updated</TableHead>
                    {canManage && <TableHead><span className="sr-only">Edit</span></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {types.map((row) => {
                    const fields = schemaToFields(row.json_schema, row.ui_schema);
                    const secrets = (row.secret_fields ?? []).length;
                    const stale = Number(row.needs_migration_count);
                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          <div className="font-medium text-ink">{row.name}</div>
                          <div className="font-mono text-xs text-ink-faint">{row.key}</div>
                          {row.description && (
                            <div className="mt-0.5 max-w-md text-xs text-ink-muted">
                              {row.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-ink-muted">
                          <span className="tabular-nums">{fields.length}</span>
                          {secrets > 0 && (
                            <Badge tone="critical" className="ml-1.5">
                              {secrets} encrypted
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums text-ink-muted">
                          {row.version ?? '—'}
                        </TableCell>
                        <TableCell className="text-ink-muted">
                          <span className="tabular-nums">{row.record_count}</span>
                          {/* The flag 0080 declared and nothing ever set until
                              the publish route did. A count here is the reason
                              somebody would publish again. */}
                          {stale > 0 && (
                            <Badge tone="warning" className="ml-1.5">
                              {stale} need migration
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {!row.is_active && <Badge tone="neutral">Inactive</Badge>}
                          {row.client_visible ? (
                            <Badge tone="notice">Client-visible</Badge>
                          ) : (
                            <Badge tone="neutral">Internal</Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-ink-faint">
                          {formatDateTime(row.updated_at)}
                        </TableCell>
                        {canManage && (
                          <TableCell>
                            <FlexibleTypeEditor
                              type={editable(row)}
                              trigger={
                                <Button variant="secondary" size="sm">Edit</Button>
                              }
                            />
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
