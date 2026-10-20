import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/ids';
import { Network } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { EmptyState, PageBody, PageHeader } from '@/components/app-shell';
import { AssetForm } from '@/components/asset-form';
import { DependencyChip, DependencyEditor } from '@/components/dependency-editor';
import { TagEditor } from '@/components/tag-editor';
import { isClientRole } from '@/lib/ui/roles';
import { isWeakStrength, strengthLabel } from '@/lib/ui/strength';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, severityTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RevealButton } from '@/components/reveal-button';
import { TotpPanel } from '@/components/totp-panel';
import { formatDate, formatDateTime, humanise } from '@/lib/ui/format';
import { recordView } from '@/lib/workspace/queries';
import { NotesCard } from '@/components/notes-card';
import { HistoryCard } from '@/components/history-card';
import { listHistory } from '@/lib/history/queries';
import { FlexibleRecordForm } from '@/components/flexible-record-form';
import { pointerFor, schemaToFields, type FieldDef } from '@/lib/flexible/fields';
import { listAssignableUsers, listRunsForSop, readTemplate } from '@/lib/sops/queries';
import { ChecklistRunsCard } from '@/components/checklist-runs-card';
import { ChecklistTemplateCard } from '@/components/checklist-template-card';
import { ChecklistSchedulesCard } from '@/components/checklist-schedules-card';
import { listSchedules } from '@/lib/sops/schedules';
import { NodeAttachmentsCard } from '@/components/node-attachments-card';
import { listNodeAttachments } from '@/lib/clients/queries';
import type { DocumentRow } from '@/lib/ui/documents';
import { maxUploadBytes } from '@/lib/documents/limits';
import { categoryBySource } from '@/lib/nav/org-categories';
import { DetailEditForm } from '@/components/detail-edit-form';
import { ConfigurationEdit } from '@/components/configuration-edit';
import { listInterfaces } from '@/lib/assets/devices';
import { detailFieldsFor, subnetMaskOf } from '@/lib/assets/detail-fields';
import { ExternalCheckNote, type ExternalCheckState } from '@/components/external-check-note';
import { readExternalCheckSetting } from '@/lib/external/settings';

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
  note: string | null;
}

interface SecretRow {
  id: string; label: string; kind: string; sensitivity: string;
  requires_reason: boolean; requires_step_up: boolean;
  strength_score: number | null; last_rotated_at: Date | null; rotation_due_at: Date | null;
}

/** The credential's TOTP enrolment, when it has one. */
interface TotpRow {
  totp_secret_id: string;
  totp_issuer: string | null;
  totp_account: string | null;
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
  if (!isUuid(nodeId)) notFound();

  const data = await withTenant(actorOf(identity), async (tx, session) => {
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
               e.note,
               other.id AS other_id, other.name AS other_name, other.node_type::text AS other_type
        FROM v_asset_edge e
        JOIN asset_node other ON other.id = e.to_node_id
        WHERE e.from_node_id = ${nodeId}::uuid
        ORDER BY other.name
      `,
      /*
       * THE TOTP SEED IS DELIBERATELY NOT IN THIS LIST.
       *
       * Every row here renders a RevealButton, which POSTs to
       * /api/secrets/{id}/reveal and displays the plaintext. For a seed that
       * plaintext is a permanent code-generating key, and putting it on screen
       * would hand over every future code for the account with one audit row to
       * show for it. The seed is surfaced as a live code by TotpPanel instead,
       * and the reveal route refuses kind 'totp_seed' outright so removing it
       * here is tidiness rather than the control.
       */
      tx<SecretRow[]>`
        SELECT m.id, m.label, m.kind::text, m.sensitivity::text, m.requires_reason,
               m.requires_step_up, m.strength_score, m.last_rotated_at, m.rotation_due_at
        FROM v_secret_metadata m
        WHERE m.id IN (
          SELECT c.secret_id FROM credential c WHERE c.id = ${nodeId}::uuid AND c.secret_id IS NOT NULL
          UNION
          SELECT s.private_key_secret_id FROM ssl_certificate s
            WHERE s.id = ${nodeId}::uuid AND s.private_key_secret_id IS NOT NULL
          UNION
          /*
           * A secret field on a custom template. The same reveal control as a
           * credential's password, because it is the same kind of material
           * written through the same audited path — and without this arm the
           * record shows a field whose value has nowhere to be read from.
           *
           * JOINED THROUGH flexible_asset_type, WHICH IS WHAT KEEPS THIS
           * HONEST. flexible_asset_type is tenant-scoped and NOT
           * organisation-scoped (0200), so its policy admits only tenant-wide
           * actors — a client-side role cannot see a template at all, and the
           * Details card above shows them nothing for the same reason. The
           * secret's own label is "<template> — <field>", so listing it
           * without this join would tell a client administrator the name of a
           * template they may not read, through a row RLS does let them see.
           * The join makes one policy decide both halves of the page instead
           * of two rules that can drift apart.
           */
          SELECT f.secret_id
            FROM flexible_asset_secret f
            JOIN flexible_asset_record r ON r.id = f.record_id
            JOIN flexible_asset_type t ON t.id = r.type_id
           WHERE f.record_id = ${nodeId}::uuid
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
      WHERE organization_id = ${node.organization_id}::uuid AND deleted_at IS NULL AND archived_at IS NULL
      ORDER BY name
    `;

    /*
     * The TOTP enrolment and whether this actor may generate a code.
     *
     * The permission is read from the database rather than inferred from the
     * role key, because role_permission is editable per deployment and a
     * per-user grant (0480) can add secret:reveal to somebody whose role does
     * not carry it. Getting this wrong would only change what the page OFFERS —
     * the code endpoint gates independently — but offering a button that always
     * refuses is its own kind of wrong.
     */
    const [totp] = await tx<TotpRow[]>`
      SELECT c.totp_secret_id, c.totp_issuer, c.totp_account
      FROM credential c
      WHERE c.id = ${nodeId}::uuid AND c.totp_secret_id IS NOT NULL
    `;
    /*
     * Three permissions in one round trip. Read from the database rather than
     * inferred from the role key, because role_permission is editable per
     * deployment and a per-user grant (0480) can add one to somebody whose role
     * does not carry it. These only decide what the page OFFERS — every route
     * and every policy checks again.
     */
    const [perm] = await tx<{ reveal: boolean; author: boolean; run: boolean }[]>`
      SELECT helm.has_permission('secret:reveal') AS reveal,
             helm.has_permission('sop:write')     AS author,
             helm.has_permission('sop:execute')   AS run
    `;

    // Only for a record, so the other eleven node types pay nothing for it.
    const record = node.node_type === 'flexible_asset'
      ? await flexibleRecord(tx, node.id)
      : null;

    // Same bargain for a procedure: its steps and published versions, read
    // only when the node is one.
    const template = node.node_type === 'sop' ? await readTemplate(tx, node.id) : null;
    // And its schedules, the runs it raises on its own (0770).
    const schedules = template ? await listSchedules(tx, node.id) : [];
    // Every run of this procedure, for the Runs card's Open / Completed tabs.
    const runs = template ? await listRunsForSop(tx, node.id) : [];
    // The diagrams a configuration is drawn on, or a network is the subject
    // of, for the way there (0880). Read under RLS, so an internal-only
    // diagram is not listed to a client user.
    const diagrams = node.node_type === 'device'
      ? await tx<{ id: string; name: string }[]>`
          SELECT DISTINCT d.id, d.name FROM topology_node t
          JOIN network_diagram d ON d.id = t.diagram_id
          WHERE t.asset_node_id = ${node.id}::uuid AND d.archived_at IS NULL
          ORDER BY d.name
        `
      : node.node_type === 'network'
        ? await tx<{ id: string; name: string }[]>`
            SELECT id, name FROM network_diagram
            WHERE network_id = ${node.id}::uuid AND archived_at IS NULL
            ORDER BY name
          `
        : [];
    /*
     * Only for the two node types a probe can reach. Read even when checking is
     * OFF, because "off" is the sentence the card needs: never checked because
     * nobody enabled it is a different fact from never checked because the
     * registry will not answer, and a card that could not tell them apart would
     * send somebody hunting a fault that does not exist.
     */
    const checkable = node.node_type === 'domain' || node.node_type === 'ssl_certificate';
    const checkSetting = checkable ? await readExternalCheckSetting(tx) : null;
    /*
     * The probe columns, read by name rather than taken from `detail`.
     *
     * detailFor() hides them — they are rendered as a sentence by
     * ExternalCheckNote, not as five humanised rows — and it also drops every
     * NULL, which is exactly the state this card exists to describe. So they
     * are selected here, typed, and `recorded` comes with them so the
     * comparison is between two values read the same way.
     */
    const checkRow = !checkable ? null : (
      node.node_type === 'domain'
        ? (await tx<{
            recorded: Date | null; observed: Date | null; checked: Date | null;
            status: string | null; error: string | null;
          }[]>`
            SELECT expires_at AS recorded, registry_expires_at AS observed,
                   last_checked_at AS checked, last_check_status::text AS status,
                   last_check_error AS error
            FROM domain WHERE id = ${node.id}::uuid
          `)[0] ?? null
        : (await tx<{
            recorded: Date | null; observed: Date | null; checked: Date | null;
            status: string | null; error: string | null;
          }[]>`
            SELECT not_after AS recorded, observed_not_after AS observed,
                   last_checked_at AS checked, last_check_status::text AS status,
                   last_check_error AS error
            FROM ssl_certificate WHERE id = ${node.id}::uuid
          `)[0] ?? null
    );
    // Only for the picker in the start-a-run dialog, so only when that dialog
    // can be opened at all.
    const assignable = template && perm?.run ? await listAssignableUsers(tx) : [];
    // Files attached to this asset (0780): the circuit's LOA, the contract's PDF.
    const attachments = await listNodeAttachments(tx, node.id);
    /*
     * A device's interfaces (0800), and the pickers its sectioned edit form
     * needs: the client's people and what an interface can connect to. Read
     * only for a device; every other kind pays nothing.
     */
    const device = node.node_type === 'device'
      ? {
          interfaces: await listInterfaces(tx, node.id),
          contacts: await tx<{ id: string; name: string }[]>`
            SELECT id, first_name || ' ' || last_name AS name FROM contact
            WHERE organization_id = ${node.organization_id}::uuid AND deleted_at IS NULL
              -- Archived people are not offered, unless already the one chosen.
              AND (archived_at IS NULL OR id = (SELECT contact_id FROM device WHERE id = ${node.id}::uuid))
            ORDER BY last_name, first_name
          `,
          connectable: await tx<{ id: string; name: string }[]>`
            SELECT id, name FROM asset_node
            WHERE organization_id = ${node.organization_id}::uuid AND archived_at IS NULL
              AND node_type IN ('device', 'network') AND id <> ${node.id}::uuid
            ORDER BY name LIMIT 500
          `,
        }
      : null;

    return {
      node, detail: detailRows.shown, detailRaw: detailRows.raw, edges, secrets, expiries, sites, record, template, schedules, runs, diagrams,
      attachments, device,
      canDeleteAttachments: session.permissions.includes('asset:delete'),
      totp: totp ?? null,
      canReveal: perm?.reveal ?? false,
      canAuthorProcedures: perm?.author ?? false,
      canRunChecklists: perm?.run ?? false,
      assignable,
      checkSetting,
      checkRow,
      history: await listHistory(tx, 'asset', node.id),
    };
  });

  if (!data) notFound();
  const {
    node, detail, detailRaw, edges, secrets, expiries, sites, record, template, schedules, runs, diagrams, totp, canReveal,
    canAuthorProcedures, canRunChecklists, assignable, checkSetting, checkRow,
    attachments, canDeleteAttachments, device, history,
  } = data;

  /*
   * The catalogue for this kind of asset: the Details card labels and formats
   * its rows from it, and Edit details writes through it. A kind with no
   * catalogue entry (a procedure, a flexible record) keeps the generic list.
   */
  const detailFields = detailFieldsFor(node.node_type);
  const fieldByKey = new Map(detailFields.map((f) => [f.key, f]));
  const detailLabel = (key: string) => fieldByKey.get(key)?.label ?? humanise(key);
  // A host address comes out of Postgres as 10.10.4.1/32; nobody writes the
  // /32, so nobody should have to read it. A subnet keeps its prefix.
  const host = (v: unknown) => (typeof v === 'string' ? v.replace(/\/(32|128)$/, '') : v);
  const detailValue = (key: string, value: unknown): string => {
    const field = fieldByKey.get(key);
    const kind = field?.kind;
    if (field?.pg === 'inet') return renderValue(host(value));
    if (field?.pg === 'inet[]' && Array.isArray(value)) return renderValue(value.map(host));
    if (kind === 'date' && typeof value === 'string') return formatDate(value);
    if (kind === 'datetime' && typeof value === 'string') return formatDateTime(value);
    if (kind === 'select' && typeof value === 'string') return humanise(value);
    return renderValue(value);
  };
  const subnetMask = node.node_type === 'network' ? subnetMaskOf(detail.cidr as string | undefined) : null;

  const attachmentRows: DocumentRow[] = attachments.map((d) => ({
    id: d.id,
    folderId: d.folder_id,
    filename: d.filename,
    contentType: d.content_type,
    byteSize: Number(d.byte_size),
    isInternalOnly: d.is_internal_only,
    archived: d.archived_at !== null,
    uploadedAt: d.uploaded_at.toISOString(),
    uploadedBy: d.uploaded_by_name,
  }));

  /*
   * The category this asset is listed under, for the crumb between the client
   * and the site. Without it the trail read Clients › Acme › Head office over
   * a firewall, and the only way back to the firewall LIST was the client page
   * and a second click.
   */
  const category = categoryBySource(node.node_type);

  /*
   * Credentials are a card on every asset page because any node can hold a
   * secret. Most never do — a contract, a licence, a domain — and an empty
   * "No credentials attached" card on each of those was the complaint. The
   * card stays where credentials are the normal case, and anywhere one has
   * actually been attached.
   *
   * Not configurations: their passwords are credential entries linked as
   * dependencies, so the card shows only on one that already holds a secret.
   */
  const CREDENTIAL_TYPES = new Set([
    'application', 'directory_service', 'network', 'vendor', 'isp_circuit',
  ]);
  const showCredentials = secrets.length > 0 || totp !== null || CREDENTIAL_TYPES.has(node.node_type);

  /** The probe's answer, shaped for the card. */
  const checkState: ExternalCheckState | null = checkSetting === null || checkRow === null
    ? null
    : {
        enabled: node.node_type === 'domain'
          ? checkSetting.domainsEnabled
          : checkSetting.certificatesEnabled,
        recorded: checkRow.recorded,
        observed: checkRow.observed,
        lastCheckedAt: checkRow.checked,
        status: (checkRow.status as ExternalCheckState['status']) ?? null,
        error: checkRow.error,
        source: node.node_type === 'domain' ? 'the registry' : 'the server',
        recordedLabel: node.node_type === 'domain' ? 'Expires' : 'Not after',
      };
  const canWrite = !isClientRole(identity.roleKey);

  /*
   * THE CARDS, named so each kind of entry can lay them out its own way:
   *
   *   A password entry has no Details card. Its username, URL and other
   *   fields sit in the Credentials card, straight under the notes, because
   *   that card is what somebody opened the entry for.
   *   Networks and configurations get a full-width Details card, like Notes:
   *   their fields are the long part of the page.
   *   Everything else keeps Details and Dependencies side by side.
   */
  const isCredential = node.node_type === 'credential';
  const wideDetails = node.node_type === 'network' || node.node_type === 'device';

  const detailsCard = (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Details</CardTitle>
        {/* Edits the TEMPLATE's fields, which is why it lives on this card
            and not beside the header's Edit: that one writes asset_node's
            own columns and knows nothing about a schema. */}
        {device && canWrite && (
          <ConfigurationEdit
            deviceId={node.id}
            organizationId={node.organization_id}
            sites={sites}
            contacts={device.contacts}
            connectable={device.connectable}
          />
        )}
        {!record && !device && canWrite && detailFields.length > 0 && (
          <DetailEditForm
            nodeId={node.id}
            nodeType={node.node_type}
            fields={detailFields}
            values={detailRaw}
          />
        )}
        {record && record.editableFields !== null && canWrite && (
          <FlexibleRecordForm
            type={{
              id: record.typeId,
              name: record.typeName,
              fields: record.editableFields,
            }}
            organizationId={node.organization_id}
            sites={sites}
            record={{
              nodeId: node.id,
              values: record.data,
              heldSecrets: record.heldSecrets,
            }}
            trigger={
              <Button variant="secondary" size="sm">
                Edit fields
              </Button>
            }
          />
        )}
      </CardHeader>
      <CardContent>
        {record ? (
          record.fields.length === 0 ? (
            <p className="text-sm text-ink-faint">
              This template has no fields, so there is nothing recorded against it.
            </p>
          ) : (
            <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
              {record.fields.map((field) => (
                <div key={field.key} className="contents">
                  <dt className="truncate text-ink-muted" title={field.help}>
                    {field.label}
                  </dt>
                  <dd className="min-w-0 break-words text-ink">
                    {field.secret ? (
                      <span className="text-ink-faint">
                        {field.held ? 'Encrypted — see Credentials below' : 'Not set'}
                      </span>
                    ) : (
                      renderValue(field.value)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )
        ) : Object.keys(detail).length === 0 ? (
          <p className="text-sm text-ink-faint">
            {detailFields.length > 0 && canWrite
              ? 'Nothing recorded yet. Edit details to fill this in.'
              : 'No type-specific detail recorded.'}
          </p>
        ) : (
          <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
            {Object.entries(detail).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate text-ink-muted">{detailLabel(key)}</dt>
                <dd className="min-w-0 break-words text-ink">
                  {detailValue(key, value)}
                  {key === 'cidr' && subnetMask && (
                    <span className="ml-2 text-xs text-ink-faint">mask {subnetMask}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-4 text-xs text-ink-faint">
          Last updated {formatDateTime(node.updated_at)}
          {record && ` · ${record.typeName} v${record.pinnedVersion}`}
        </p>
        {record?.needsMigration && (
          <p className="mt-2 text-xs text-warning">
            This record was written against version {record.pinnedVersion} of the template,
            which has since changed in a way that may not accept it. Opening “Edit fields”
            and saving validates it against the current version and clears this.
          </p>
        )}
      </CardContent>
    </Card>
  );

  /*
   * Above Dependencies because it is about THIS asset's own facts, and
   * below the detail card because it comments on a value shown there.
   * Rendered whenever the node type is probeable — including when
   * checking is switched off, since "off" is the sentence that stops
   * somebody hunting a fault that does not exist.
   */
  const checkNote = checkState && <ExternalCheckNote state={checkState} />;

  const dependenciesCard = (
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
          /*
            Chips, not a labelled list. Each one IS the link to the asset
            it names, so the obvious click goes where the reader expects
            rather than to a small piece of text beside a relation label
            most people had to translate anyway. The note, if there is
            one, is the chip's tooltip.
          */
          <div className="flex flex-wrap gap-2">
            {edges.map((edge) => (
              <DependencyChip
                key={`${edge.relation}:${edge.other_id}`}
                href={`/assets/${edge.other_id}`}
                label={edge.other_name}
                kind={humanise(edge.other_type)}
                note={edge.note}
                removable={edge.origin === 'manual' && canWrite}
                sourceNodeId={node.id}
                relation={edge.relation}
                targetNodeId={edge.other_id}
              />
            ))}
          </div>
        )}
        <DependencyEditor
          nodeId={node.id}
          organizationId={node.organization_id}
          canLink={canWrite}
        />
      </CardContent>
    </Card>
  );

  const credentialFacts = isCredential && Object.keys(detail).length > 0 ? (
    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
      {Object.entries(detail).map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="truncate text-ink-muted">{detailLabel(key)}</dt>
          <dd className="min-w-0 break-words text-ink">{detailValue(key, value)}</dd>
        </div>
      ))}
    </dl>
  ) : null;

  const credentialsCard = (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Credentials</CardTitle>
        {/* A password entry has no Details card: its username, URL and the
            rest of its fields are edited and shown here, beside the secret. */}
        {isCredential && canWrite && detailFields.length > 0 && (
          <DetailEditForm
            nodeId={node.id}
            nodeType={node.node_type}
            fields={detailFields}
            values={detailRaw}
          />
        )}
      </CardHeader>
      <CardContent className={secrets.length === 0 && !totp && !credentialFacts ? 'p-0' : 'space-y-5'}>
        {credentialFacts}
        {secrets.length === 0 && !totp ? (
          <EmptyState title={isCredential ? 'No password stored' : 'No credentials attached to this asset'} />
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
                {isWeakStrength(secret.strength_score) && (
                  <Badge tone="warning">{strengthLabel(secret.strength_score)}</Badge>
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
        {totp && (
          <TotpPanel
            nodeId={node.id}
            issuer={totp.totp_issuer}
            account={totp.totp_account}
            canReveal={canReveal}
          />
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        title={node.name}
        description={node.description ?? undefined}
        // The site is where this asset sits, and opens that location's page.
        trail={[
          { label: 'Clients', href: '/organizations' },
          { label: node.organization_name, href: `/organizations/${node.organization_id}` },
          ...(category
            ? [{ label: category.label, href: `/organizations/${node.organization_id}/${category.slug}` }]
            : []),
          ...(node.site_name && node.site_id
            ? [{ label: node.site_name, href: `/locations/${node.site_id}` }]
            : []),
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
          {/* The TEMPLATE's name for a record, because "Flexible asset" is what
              the schema calls this row and "Backup Job" is what it is. */}
          <Badge tone="brand">{record ? record.typeName : humanise(node.node_type)}</Badge>
          {record?.needsMigration && (
            <Badge tone="warning">Needs migration</Badge>
          )}
          <Badge tone={node.status === 'active' ? 'ok' : 'neutral'}>{node.status}</Badge>
          <Badge tone={node.criticality >= 4 ? 'critical' : 'neutral'}>
            Criticality {node.criticality}
          </Badge>
          {node.site_name && node.site_id && (
            <Link href={`/locations/${node.site_id}`}>
              <Badge tone="neutral">{node.site_name}</Badge>
            </Link>
          )}
          {/* Editable rather than decorative: same control, same endpoint. */}
          <TagEditor target="node" id={node.id} tags={node.tags} canWrite={canWrite} />
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

        {isCredential ? (
          <>
            {credentialsCard}
            {dependenciesCard}
          </>
        ) : wideDetails ? (
          <>
            {detailsCard}
            {checkNote}
            {dependenciesCard}
            {(diagrams.length > 0 || node.node_type === 'network') && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Network className="size-4 text-ink-faint" aria-hidden />
                    {node.node_type === 'network' ? 'Diagrams of this network' : 'On network diagrams'}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {diagrams.length === 0 && (
                    <p className="text-sm text-ink-faint">
                      No diagram is about this network yet. Draw one under{' '}
                      <Link href={`/organizations/${node.organization_id}/diagrams`} className="text-ink hover:underline">
                        Diagrams
                      </Link>
                      {' '}and choose this network.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {diagrams.map((d) => (
                      <Link key={d.id} href={`/diagrams/${d.id}`} className="rounded-md border border-border px-2.5 py-1 text-sm text-ink hover:bg-surface-sunken">
                        {d.name}
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {detailsCard}
            {checkNote}
            {dependenciesCard}
          </div>
        )}

        {/*
          A procedure's steps, its published versions, and the controls that
          edit, publish and run it. Below the details and dependencies because
          the steps are the long part of the page, and above Credentials
          because a procedure rarely has any.
        */}
        {template && (
          <ChecklistTemplateCard
            sopId={node.id}
            organizationId={node.organization_id}
            sopName={node.name}
            template={template}
            canAuthor={canAuthorProcedures}
            canRun={canRunChecklists}
            assignable={assignable}
          />
        )}
        {template && (
          <ChecklistSchedulesCard
            sopId={node.id}
            sopName={node.name}
            published={template.current !== null}
            schedules={schedules}
            canManage={canRunChecklists}
            assignable={assignable}
            sites={sites}
          />
        )}
        {template && <ChecklistRunsCard runs={runs} title="Runs" showClient />}

        {!isCredential && showCredentials && credentialsCard}

        {device && (
          <Card>
            <CardHeader>
              <CardTitle>Interfaces</CardTitle>
            </CardHeader>
            <CardContent className={device.interfaces.length === 0 ? 'p-0' : undefined}>
              {device.interfaces.length === 0 ? (
                <EmptyState title="No interfaces recorded" />
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Name</th>
                      <th className="py-1 pr-3 font-medium">IP address</th>
                      <th className="py-1 pr-3 font-medium">MAC</th>
                      <th className="py-1 pr-3 font-medium">Port</th>
                      <th className="py-1 pr-3 font-medium">Connected to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {device.interfaces.map((i) => (
                      <tr key={i.id} className="border-t border-border">
                        <td className="py-1.5 pr-3 text-ink">
                          {i.name ?? '—'}
                          {i.isPrimary && <Badge tone="brand" className="ml-2">Primary</Badge>}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-ink-muted">{i.ipAddress ?? '—'}</td>
                        <td className="py-1.5 pr-3 font-mono text-ink-muted">{i.macAddress ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{i.port ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">
                          {i.connectedToNodeId ? (
                            <Link href={`/assets/${i.connectedToNodeId}`} className="text-brand hover:underline">
                              {i.connectedToName ?? 'asset'}
                            </Link>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}

        {/* Not on a password entry, unless something is already attached. */}
        {(!isCredential || attachmentRows.length > 0) && (
          <NodeAttachmentsCard
            nodeId={node.id}
            organizationId={node.organization_id}
            attachments={attachmentRows}
            canWrite={canWrite}
            canDelete={canDeleteAttachments}
            maxBytes={maxUploadBytes()}
          />
        )}

        <HistoryCard entries={history} />
      </PageBody>
    </>
  );
}

/** One field of a record, ready to render. */
interface RenderedField {
  key: string;
  label: string;
  help: string | undefined;
  value: unknown;
  secret: boolean;
  /** For a secret field: whether a value is actually stored. */
  held: boolean;
}

interface FlexibleRecordView {
  typeId: string;
  typeName: string;
  /** The version the record is pinned to — the schema that describes `data`. */
  pinnedVersion: number;
  needsMigration: boolean;
  data: Record<string, unknown>;
  heldSecrets: string[];
  /** Rendered against the PINNED version. */
  fields: RenderedField[];
  /** The CURRENT version's fields, for editing. null when there is none. */
  editableFields: FieldDef[] | null;
}

/**
 * A flexible asset record, decoded far enough to be rendered.
 *
 * WHY THIS IS NOT A DETAIL_TABLES ENTRY. Every other node type has a subtype
 * table whose columns ARE the fields, so `to_jsonb(t)` and humanise() on each
 * key is a faithful rendering. A record's fields live in one jsonb document
 * whose keys are identifiers chosen by whoever defined the template, and whose
 * labels, order, kinds and help text are in the schema version beside it. Sent
 * through the generic path it rendered as nothing at all — flexible_asset was
 * simply absent from the map, so detailFor() returned {} and every record in
 * the product displayed "No type-specific detail recorded" over its entire
 * contents.
 *
 * TWO VERSIONS, FOR TWO DIFFERENT QUESTIONS, and conflating them is the subtle
 * bug this avoids:
 *
 *   - READING uses the version the record is PINNED to. That schema is the one
 *     that describes the keys actually in `data`: it has a label for each of
 *     them and does not promise fields the document never had. Rendering
 *     against the current version would drop a field removed since — showing a
 *     reader less than the record contains.
 *
 *   - EDITING uses the type's CURRENT version, because a save is validated
 *     against it. Offering the pinned fields would produce a form that cannot
 *     be saved the moment the template moves on.
 *
 * Normally they are the same row and the distinction costs nothing.
 */
async function flexibleRecord(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  nodeId: string,
): Promise<FlexibleRecordView | null> {
  const [row] = await tx<{
    type_id: string; type_name: string; data: Record<string, unknown>;
    needs_migration: boolean; pinned_version: number;
    pinned_schema: unknown; pinned_ui: unknown;
    current_schema: unknown; current_ui: unknown;
  }[]>`
    SELECT r.type_id, t.name AS type_name, r.data, r.needs_migration,
           pinned.version AS pinned_version,
           pinned.json_schema AS pinned_schema, pinned.ui_schema AS pinned_ui,
           cur.json_schema AS current_schema, cur.ui_schema AS current_ui
    FROM flexible_asset_record r
    JOIN flexible_asset_type t ON t.id = r.type_id
    JOIN flexible_asset_type_version pinned ON pinned.id = r.type_version_id
    -- LEFT, and twice over: current_version_id is ON DELETE SET NULL, and a
    -- retired type should still render the records written under it rather
    -- than making them unreadable as well as uneditable.
    LEFT JOIN flexible_asset_type_version cur
           ON cur.id = t.current_version_id AND t.is_active
    WHERE r.id = ${nodeId}::uuid
  `;
  if (!row) return null;

  const held = new Set(
    (
      await tx<{ field_path: string }[]>`
        SELECT field_path FROM flexible_asset_secret WHERE record_id = ${nodeId}::uuid
      `
    ).map((r) => r.field_path),
  );

  const defined = schemaToFields(row.pinned_schema, row.pinned_ui);
  const fields: RenderedField[] = defined.map((field) => ({
    key: field.key,
    label: field.label,
    help: field.help,
    value: row.data[field.key],
    secret: field.kind === 'secret',
    held: held.has(pointerFor(field.key)),
  }));

  /*
   * Anything in the document the pinned schema does not describe, appended.
   *
   * It should not happen — every write validates with additionalProperties:
   * false — so this is for the row that arrived by SQL, by import, or from a
   * schema edited outside the field model. Showing it with humanise() on the
   * raw key is ugly on purpose: a field with no label is visibly not part of
   * the template, which is better than a value nobody can see.
   */
  const describedKeys = new Set(defined.map((f) => f.key));
  for (const [key, value] of Object.entries(row.data)) {
    if (describedKeys.has(key)) continue;
    fields.push({
      key,
      label: humanise(key),
      help: 'Not declared by this version of the template.',
      value,
      secret: false,
      held: false,
    });
  }

  return {
    typeId: row.type_id,
    typeName: row.type_name,
    pinnedVersion: row.pinned_version,
    needsMigration: row.needs_migration,
    data: row.data,
    heldSecrets: [...held],
    fields,
    editableFields:
      row.current_schema === null ? null : schemaToFields(row.current_schema, row.current_ui),
  };
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
  /*
   * Added in F1. `sop` has been an asset_node subtype since 0090 and was
   * missing here for the same reason flexible_asset was: nothing in the
   * application touched it, so nobody noticed that opening a procedure showed
   * "No type-specific detail recorded" over its category, summary and review
   * schedule. Its steps get a card of their own below — a procedure's steps
   * are its substance, not a detail field.
   */
  ['sop', 'sop'],
]);

async function detailFor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  nodeType: string,
  nodeId: string,
): Promise<{ shown: Record<string, unknown>; raw: Record<string, unknown> }> {
  const table = DETAIL_TABLES.get(nodeType);
  if (!table) return { shown: {}, raw: {} };

  const rows = await tx<{ row: Record<string, unknown> }[]>`
    SELECT to_jsonb(t) - 'id' - 'tenant_id' - 'node_type' AS row
    FROM ${tx(table)} t WHERE t.id = ${nodeId}::uuid
  `;

  const row = rows[0]?.row ?? {};
  /*
   * Secret *references* are shown elsewhere as a reveal control; listing the id
   * as a detail field is noise, and inviting someone to copy it is worse.
   *
   * The totp_* parameters go the same way, and they were noise long before
   * anything could store a seed: credential.totp_algorithm, totp_digits and
   * totp_period_seconds are NOT NULL with defaults (0070), so EVERY credential
   * has rendered "Totp algorithm SHA1 · Totp digits 6 · Totp period seconds 30"
   * whether or not it had a second factor. They describe how to compute a code,
   * which is TotpPanel's business, and they mean nothing on a credential with no
   * seed.
   */
  /*
   * The totp_* parameters, and 0670's check bookkeeping.
   *
   * next_check_at is scheduling machinery — the answer to "when will a worker
   * get round to this" is nobody's business on an asset page — and the status,
   * error and observed value are all rendered properly by ExternalCheckNote
   * below, where they can be a sentence instead of five humanised rows.
   * Leaving them in the generic list as well would say everything twice and
   * badly.
   */
  const HIDDEN = new Set([
    'totp_algorithm', 'totp_digits', 'totp_period_seconds', 'totp_issuer', 'totp_account',
    'next_check_at', 'last_checked_at', 'last_check_status', 'last_check_error',
    'registry_expires_at', 'observed_not_after', 'observed_fingerprint_sha256',
  ]);
  /*
   * Person ids go the same way as secret ids: a raw uuid in a detail list is
   * noise whatever it points at, and inviting somebody to read one is worse.
   * Checked against the catalogue before generalising — `owner_user_id` and
   * `reviewed_by` on `sop` are the ONLY columns in all twelve subtype tables
   * that match, so this changes nothing for the other eleven. Where who did it
   * matters, the page resolves the name and says it in prose.
   */
  const isPersonId = (key: string) => key.endsWith('_user_id') || key.endsWith('_by');
  /*
   * Relationships are shown by the Dependencies card as names, not here as
   * uuids. And a default that nobody set is not a detail: an unticked flag, an
   * empty list, an empty object are what the schema wrote when the row was
   * created, and listing "Guest network No · Auto renew No · Fsmo roles {}"
   * under a thing nobody has described yet was the complaint about this card.
   */
  const RELATIONSHIPS = new Set([
    'vendor_id', 'registrar_vendor_id', 'domain_id', 'application_id', 'sso_directory_id',
    'signed_by_contact_id', 'parent_device_id', 'primary_network_id',
  ]);
  const isRelationship = (key: string) => key.endsWith('_node_id') || RELATIONSHIPS.has(key);
  const isDefault = (value: unknown) =>
    value === false
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
  const shown = Object.fromEntries(
    Object.entries(row).filter(
      ([key, value]) =>
        value !== null && value !== '' && !isDefault(value)
        && !key.endsWith('_secret_id') && !isPersonId(key) && !isRelationship(key) && !HIDDEN.has(key),
    ),
  );
  return { shown, raw: row };
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
