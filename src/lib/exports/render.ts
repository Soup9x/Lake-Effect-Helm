/**
 * Turning a collected export into bytes.
 *
 * Two renderings of the same data, and a bundle contains both for a reason:
 *
 *   JSON is the machine-readable truth. Complete, unmangled, every field, every
 *   identifier. It is what a receiving MSP imports and what an auditor greps.
 *
 *   PDF is what a person reads and signs. It is necessarily lossy — tables
 *   truncate, WinAnsi cannot render every script — and so it is never the only
 *   artefact. Where the PDF says "..." the JSON has the whole value.
 *
 * Secret material appears only when the job was approved to carry it, and even
 * then the PDF marks each credential's provenance so that a reader can tell a
 * revealed password from one that was withheld.
 */
import { PdfDocument } from './pdf';
import type { CollectedExport, CredentialRecord } from './collect';

export interface RenderOptions {
  readonly kind: string;
  readonly includeSecrets: boolean;
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly omissions: ExportOmission[];
}

export interface ExportOmission {
  readonly secretId: string;
  readonly label: string;
  readonly reason: string;
}

const KIND_TITLES: Record<string, string> = {
  client_offboarding: 'Client Offboarding Handover',
  compliance_audit: 'Compliance Audit Pack',
  disaster_recovery: 'Disaster Recovery Runbook',
  asset_inventory: 'Asset Inventory',
  ad_hoc: 'Documentation Export',
};

export function renderJson(data: CollectedExport, options: RenderOptions): Buffer {
  const document = {
    helm: {
      schema: 'lake-effect-helm/export/v1',
      kind: options.kind,
      generatedAt: data.attestation.generatedAt,
      includesSecrets: options.includeSecrets,
      reason: options.reason,
      requestedBy: options.requestedBy,
      approvedBy: options.approvedBy,
      // Named at the top level rather than buried: a consumer diffing two
      // handover packs needs to know immediately whether one is incomplete.
      omittedSecrets: options.omissions,
      attestation: data.attestation,
    },
    organization: data.organization,
    sites: data.sites,
    contacts: data.contacts,
    assets: data.assets,
    credentials: data.credentials,
    relationships: data.relationships,
    expirations: data.expirations,
    procedures: data.procedures,
    flexibleAssets: data.flexibleAssets,
  };

  return Buffer.from(`${JSON.stringify(document, jsonReplacer, 2)}\n`, 'utf8');
}

/** Dates as ISO strings; Buffers never belong in an export document. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return value;
}

export function renderPdf(data: CollectedExport, options: RenderOptions): Buffer {
  const title = KIND_TITLES[options.kind] ?? 'Documentation Export';
  const org = data.organization;

  const banner = options.includeSecrets
    ? `CONFIDENTIAL — CONTAINS CREDENTIALS — ${org.name}`
    : `CONFIDENTIAL — ${org.name}`;

  const doc = new PdfDocument({ title: `${org.name} — ${title}`, footer: banner });

  // ---- Cover -------------------------------------------------------------
  doc.heading(org.name, 1);
  doc.paragraph(title, { size: 12, grey: 0.35 });
  doc.spacer(6);

  doc.definitions([
    ['Prepared by', data.attestation.tenantName],
    ['Generated', data.attestation.generatedAt],
    ['Requested by', options.requestedBy],
    ['Approved by', options.approvedBy ?? 'not required (no credentials included)'],
    ['Reason', options.reason],
    ['Credentials', options.includeSecrets ? 'INCLUDED — handle accordingly' : 'metadata only'],
  ]);

  if (options.includeSecrets) {
    doc.paragraph(
      'This document contains decrypted credential material. Every credential in it was ' +
        'read individually and each read is recorded in the audit log. Treat this file as ' +
        'equivalent to the credentials themselves: it should be transferred over an ' +
        'encrypted channel, stored only as long as the handover requires, and destroyed ' +
        'afterwards.',
      { grey: 0.3 },
    );
  }

  if (options.omissions.length > 0) {
    // First-class, on the cover, before anything else. A handover that quietly
    // dropped credentials is discovered by the client at the worst moment.
    doc.heading(`${options.omissions.length} credential(s) could not be included`, 2);
    doc.table(
      [{ header: 'Credential', width: 0.5 }, { header: 'Reason', width: 0.5 }],
      options.omissions.map((o) => [o.label, humaniseOmission(o.reason)]),
    );
  }

  // ---- Attestation -------------------------------------------------------
  doc.heading('Attestation', 2);
  const attestation = data.attestation;
  const anchorGap = attestation.auditChainSeq - attestation.auditAnchoredSeq;

  doc.definitions([
    ['Audit events', String(attestation.auditChainSeq)],
    [
      'Externally anchored',
      attestation.auditAnchoredAt
        ? `sequence ${attestation.auditAnchoredSeq} at ${attestation.auditAnchoredAt}` +
          (anchorGap > 0 ? ` (${anchorGap} event(s) since)` : '')
        : 'never — the audit chain has no external witness',
    ],
    ['Anchor reference', attestation.auditAnchorRef ?? '—'],
    [
      'Key custody',
      attestation.keyCustody.length
        ? attestation.keyCustody
            .map((k) => `${k.kekId} (${k.provider}${k.hostHeldKek ? ', host-held' : ''})`)
            .join('; ')
        : 'no tenant key',
    ],
  ]);

  if (attestation.keyCustody.some((k) => k.developmentKey)) {
    doc.paragraph(
      'WARNING: at least one encryption key in this tenant is a development key. ' +
        'This data should not be treated as having been protected to production standards.',
      { grey: 0.2 },
    );
  }

  // ---- Organisation ------------------------------------------------------
  doc.pageBreak().heading('Organisation', 1);
  doc.definitions([
    ['Legal name', org.legal_name ?? org.name],
    ['Status', org.status],
    ['Industry', org.industry ?? '—'],
    ['Employees', org.employee_count ? String(org.employee_count) : '—'],
    ['Time zone', org.timezone ?? '—'],
    ['Website', org.website ?? '—'],
    ['Onboarded', org.onboarded_at ? isoDate(org.onboarded_at) : '—'],
    ['Offboarded', org.offboarded_at ? isoDate(org.offboarded_at) : '—'],
  ]);

  if (data.sites.length) {
    doc.heading('Sites', 2);
    doc.table(
      [
        { header: 'Site', width: 0.26 },
        { header: 'Address', width: 0.34 },
        { header: 'City', width: 0.18 },
        { header: 'Phone', width: 0.22 },
      ],
      data.sites.map((s) => [
        s.is_primary ? `${s.name} (primary)` : s.name,
        s.address_line1 ?? '—',
        [s.city, s.region, s.postal_code].filter(Boolean).join(' '),
        s.main_phone ?? s.after_hours_phone ?? '—',
      ]),
    );
  }

  if (data.contacts.length) {
    doc.heading('Contacts', 2);
    doc.table(
      [
        { header: 'Name', width: 0.26 },
        { header: 'Role', width: 0.22 },
        { header: 'Email', width: 0.32 },
        { header: 'Phone', width: 0.2 },
      ],
      data.contacts.map((c) => [
        `${c.first_name} ${c.last_name ?? ''}`.trim(),
        [c.title, c.is_emergency ? 'emergency' : null, c.is_authorised ? 'authorised' : null]
          .filter(Boolean)
          .join(', ') || '—',
        c.email ?? '—',
        c.phone ?? c.mobile ?? '—',
      ]),
    );
  }

  // ---- Assets ------------------------------------------------------------
  const byType = new Map<string, typeof data.assets>();
  for (const asset of data.assets) {
    const list = byType.get(asset.node_type) ?? [];
    list.push(asset);
    byType.set(asset.node_type, list);
  }

  if (byType.size) {
    doc.pageBreak().heading('Assets', 1);
    doc.paragraph(
      `${data.assets.length} asset(s) across ${byType.size} type(s). Full field detail for ` +
        'every asset is in the JSON companion to this document.',
      { grey: 0.35 },
    );

    for (const [type, assets] of [...byType].sort(([a], [b]) => (a < b ? -1 : 1))) {
      doc.heading(`${humaniseType(type)} (${assets.length})`, 2);
      doc.table(
        [
          { header: 'Name', width: 0.32 },
          { header: 'Key detail', width: 0.44 },
          { header: 'Status', width: 0.12 },
          { header: 'Crit.', width: 0.12 },
        ],
        assets.map((a) => [a.name, summariseDetail(type, a.detail), a.status, String(a.criticality)]),
      );
    }
  }

  // ---- Credentials -------------------------------------------------------
  if (data.credentials.length) {
    doc.pageBreak().heading('Credentials', 1);
    doc.paragraph(
      options.includeSecrets
        ? 'Decrypted credential material follows. Each value below was individually ' +
            'decrypted and individually recorded in the audit log.'
        : 'Credential metadata only. No secret material is included in this export.',
      { grey: 0.3 },
    );

    for (const credential of data.credentials) {
      doc.heading(credential.name, 3);
      doc.definitions(credentialRows(credential, options.includeSecrets), 130);
    }
  }

  // ---- Expiring ----------------------------------------------------------
  if (data.expirations.length) {
    doc.pageBreak().heading('Expiring items', 1);
    doc.table(
      [
        { header: 'Item', width: 0.4 },
        { header: 'Type', width: 0.22 },
        { header: 'Expires', width: 0.2 },
        { header: 'Days', width: 0.1 },
        { header: 'Severity', width: 0.08 },
      ],
      data.expirations.map((e) => [
        e.label,
        humaniseType(e.kind),
        isoDate(e.expires_at),
        String(e.days_remaining),
        e.severity,
      ]),
    );
  }

  // ---- Relationships -----------------------------------------------------
  if (data.relationships.length) {
    doc.pageBreak().heading('Dependencies', 1);
    doc.paragraph(
      'The documented relationships between assets. This is what tells the receiving ' +
        'team that taking a firewall offline removes a public IP, which terminates an ' +
        'SSL certificate, which takes down an application.',
      { grey: 0.35 },
    );
    doc.table(
      [
        { header: 'From', width: 0.36 },
        { header: 'Relation', width: 0.28 },
        { header: 'To', width: 0.36 },
      ],
      data.relationships.map((r) => [r.source_name, humaniseType(r.relation), r.target_name]),
    );
  }

  // ---- Procedures --------------------------------------------------------
  if (data.procedures.length) {
    doc.pageBreak().heading('Procedures', 1);
    for (const procedure of data.procedures) {
      doc.heading(procedure.name, 2);
      if (procedure.category) doc.paragraph(`Category: ${procedure.category}`, { grey: 0.4 });
      if (procedure.summary) doc.paragraph(procedure.summary);
      for (const step of procedure.steps) {
        doc.paragraph(`${step.position}. ${step.title}`, { size: 9.5, grey: 0.1 });
        if (step.body) doc.paragraph(`     ${step.body}`, { size: 9, grey: 0.35 });
      }
    }
  }

  // ---- Flexible assets ---------------------------------------------------
  if (data.flexibleAssets.length) {
    doc.pageBreak().heading('Custom asset templates', 1);
    for (const record of data.flexibleAssets) {
      doc.heading(`${record.name} (${record.type_name})`, 3);
      doc.definitions(
        Object.entries(record.data).map(([k, v]) => [k, formatValue(v)] as const),
        160,
      );
    }
  }

  return doc.render();
}

function credentialRows(
  credential: CredentialRecord,
  includeSecrets: boolean,
): (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [
    ['Type', credential.credential_type],
    ['Username', credential.username ?? '—'],
    ['URL', credential.url ?? '—'],
    ['Sensitivity', credential.sensitivity ?? '—'],
  ];

  if (credential.is_break_glass) rows.push(['Break glass', 'yes — emergency use, audited']);
  if (!credential.client_visible) rows.push(['Visibility', 'internal to the MSP']);

  if (includeSecrets) {
    rows.push([
      'Password',
      credential.material ?? (credential.secret_id ? 'WITHHELD — see omissions' : '—'),
    ]);
    if (credential.totp_secret_id) {
      rows.push(['TOTP seed', credential.totp_seed ?? 'WITHHELD — see omissions']);
    }
  } else if (credential.secret_id) {
    rows.push(['Password', 'stored in Helm; not included in this export']);
  }

  if (credential.notes) rows.push(['Notes', credential.notes]);
  return rows;
}

function humaniseOmission(reason: string): string {
  switch (reason) {
    case 'step_up_required':
      return 'requires interactive re-authentication, which a background render cannot perform';
    case 'insufficient_role_rank':
      return 'above the export worker’s role rank';
    case 'key_destroyed':
      return 'its encryption key has been destroyed; the value is unrecoverable';
    case 'not_found':
      return 'no longer present';
    default:
      return reason.replace(/_/g, ' ');
  }
}

function humaniseType(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

/** One line of the fields that matter most for each asset type. */
function summariseDetail(type: string, detail: Record<string, unknown>): string {
  const pick = (...keys: string[]): string =>
    keys
      .map((k) => detail[k])
      .filter((v) => v !== null && v !== undefined && v !== '')
      .map(formatValue)
      .join(' · ');

  switch (type) {
    case 'device':
      return pick('device_type', 'hostname', 'operating_system', 'serial_number');
    case 'network':
      return pick('cidr', 'vlan_id', 'gateway');
    case 'ip_address':
      return pick('address', 'kind');
    case 'domain':
      return pick('domain_name', 'registrar', 'expires_at');
    case 'ssl_certificate':
      return pick('common_name', 'issuer', 'not_after');
    case 'application':
      return pick('category', 'version', 'url');
    case 'directory_service':
      return pick('kind', 'domain_name', 'entra_primary_domain');
    case 'contract':
      return pick('contract_number', 'contract_type', 'ends_at');
    case 'license':
      return pick('license_type', 'seats_purchased', 'expires_at');
    case 'isp_circuit':
      return pick('circuit_id', 'service_type', 'download_mbps');
    default:
      return pick(...Object.keys(detail).slice(0, 3));
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
