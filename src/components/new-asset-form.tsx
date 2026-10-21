'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Server } from 'lucide-react';
import { Button } from './ui/button';
import { Modal } from './ui/modal';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { apiFetch } from '@/lib/ui/api';
import { NODE_STATUSES } from '@/lib/assets/statuses';
import { detailFieldsFor } from '@/lib/assets/detail-fields';
import { DetailFieldInputs, toPayload, type Draft } from './detail-edit-form';

/**
 * Documenting an asset.
 *
 * An asset is a node plus a subtype row, and six of the eleven kinds cannot be
 * written without one extra field — a device has no meaning without its device
 * type, an IP address without an address. The form asks for exactly that one
 * field and only for the kinds that need it, rather than showing every column
 * of every subtype and letting the technician work out which apply.
 *
 * The other five subtypes have nothing mandatory, so those kinds ask nothing
 * extra. The rest of each subtype's columns are edited on the asset's own page;
 * this form exists to get the thing documented, not to finish it.
 */
const KINDS = [
  ['device', 'Device'],
  ['network', 'Network'],
  ['domain', 'Domain'],
  ['ssl_certificate', 'SSL certificate'],
  ['directory_service', 'Directory service'],
  ['application', 'Application'],
  ['vendor', 'Vendor'],
  ['contract', 'Contract'],
  ['license', 'Licence'],
  ['isp_circuit', 'ISP circuit'],
] as const;

const DEVICE_TYPES = [
  'server',
  'workstation',
  'laptop',
  'virtual_machine',
  'hypervisor',
  'firewall',
  'router',
  'switch',
  'access_point',
  'nas',
  'san',
  'printer',
  'ups',
  'camera',
  'phone_system',
  'iot',
  'other',
] as const;

const NETWORK_KINDS = ['vlan', 'subnet', 'wan', 'vpn', 'wifi', 'management'] as const;

const DIRECTORY_KINDS = [
  'active_directory',
  'entra_id',
  'hybrid',
  'ldap',
  'google_workspace',
  'okta',
] as const;

/**
 * What a name looks like for each kind. One example for everything read
 * "DC01" on a new licence and a new contract, which reads as a suggestion to
 * name them after a domain controller.
 */
const NAME_PLACEHOLDER: Record<string, string> = {
  device: 'DC01',
  network: 'Office LAN',
  ssl_certificate: 'Main website',
  directory_service: 'Northwind AD',
  application: 'Line-of-business CRM',
  vendor: 'Dell',
  contract: 'Managed services agreement',
  license: 'Microsoft 365 Business Premium',
  isp_circuit: 'Spectrum fibre — HQ',
};

/**
 * Kinds whose name IS their one required field. A domain is called by its
 * domain name; asking for both meant typing northwind.example twice, or
 * filing it under a label nobody would search for.
 */
const NAME_IS_EXTRA = new Set(['domain']);

/**
 * Kinds whose whole Details form is asked for at creation, rather than in
 * Edit details afterwards, each with the one field the kind is created by —
 * asked for above, so left out here. A domain is documented once, from the
 * registrar's page, with everything in front of you; a network the same way,
 * from the firewall's: making somebody save it and then open it again to type
 * the subnet and gateway was the complaint.
 */
const DETAILS_AT_CREATE: Record<string, string> = {
  domain: 'domain_name',
  network: 'kind',
};
const detailsAtCreate = (nodeType: string) => {
  const askedAbove = DETAILS_AT_CREATE[nodeType];
  return askedAbove ? detailFieldsFor(nodeType).filter((f) => f.key !== askedAbove) : [];
};

const humanise = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

interface Site {
  id: string;
  name: string;
}

/*
 * CONTROLLED OPEN, OPTIONAL. Passing `open`/`onOpenChange` lets a parent drive
 * this form and suppresses its own trigger button — which is how the redesigned
 * view header's single green "+ New" opens whichever form the current category
 * needs. Left out, the form keeps its own button and its own state exactly as
 * before, so every existing call site is untouched.
 */
export function NewAssetForm({
  organizationId,
  sites,
  open: controlledOpen,
  onOpenChange,
  lockedNodeType,
}: {
  organizationId: string;
  sites: Site[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Pin the form to one kind of asset and hide the picker. Set when the form is
   * opened from inside a category: somebody who clicked "+ New" on Networks has
   * already said what they are making, and offering the choice again is a way to
   * file a switch under Domains.
   */
  lockedNodeType?: string;
}) {
  const router = useRouter();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [nodeType, setNodeType] = useState<string>(lockedNodeType ?? 'device');
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [extra, setExtra] = useState('');
  const [notes, setNotes] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<string>('active');
  const [criticality, setCriticality] = useState(3);
  const [tagText, setTagText] = useState('');
  const [detail, setDetail] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setName('');
    setSiteId('');
    setExtra('');
    setNotes('');
    setDescription('');
    setStatus('active');
    setCriticality(3);
    setTagText('');
    setDetail({});
    setNodeType('device');
    setError(null);
    setOpen(false);
  }

  /** The one extra field this kind cannot be created without, if any. */
  function extraField(): { label: string; hint?: string; options?: readonly string[] } | null {
    switch (nodeType) {
      case 'device':
        return { label: 'Device type', options: DEVICE_TYPES };
      case 'network':
        return { label: 'Network kind', options: NETWORK_KINDS };
      case 'directory_service':
        return { label: 'Directory kind', options: DIRECTORY_KINDS };
      case 'domain':
        return { label: 'Domain name', hint: 'e.g. northwind.example — this is also what it is called.' };
      case 'ssl_certificate':
        return { label: 'Common name', hint: 'e.g. www.northwind.example' };
      default:
        return null;
    }
  }

  const field = extraField();
  const detailFields = detailsAtCreate(nodeType);
  // A select always has a value; a free-text one starts empty and is required.
  const extraValue = field?.options ? extra || field.options[0]! : extra;

  const EXTRA_KEY: Record<string, string> = {
    device: 'deviceType',
    network: 'networkKind',
    directory_service: 'directoryKind',
    domain: 'domainName',
    ssl_certificate: 'commonName',
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = EXTRA_KEY[nodeType];
      // Only what was filled in, as Edit details would send it; a box left
      // empty is not a value, and a tick left alone keeps the column default.
      const detailPayload = Object.fromEntries(
        detailFields
          .filter((f) => (f.kind === 'boolean' ? detail[f.key] !== undefined : String(detail[f.key] ?? '').trim() !== ''))
          .map((f) => [f.key, toPayload(f, detail[f.key]!)]),
      );
      const result = await apiFetch('/api/assets', {
        json: {
          organizationId,
          nodeType,
          name: NAME_IS_EXTRA.has(nodeType) ? extraValue.trim() : name.trim(),
          ...(siteId ? { siteId } : {}),
          ...(key ? { [key]: extraValue } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          status,
          criticality,
          tags: tagText.split(',').map((t) => t.trim()).filter(Boolean),
          ...(Object.keys(detailPayload).length > 0 ? { detail: detailPayload } : {}),
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }


  return (
    <>
      {controlledOpen === undefined && (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <Plus />
        Document an asset
      </Button>
      )}

      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Every close discards: the X, the backdrop and Escape all land here,
          // and a half-filled form should not survive any of them.
          if (!next) { close() }
        }}
        /* Named for what is being made when the caller pinned the type: a
           dialog headed "Document an asset" after pressing "+ New" on Networks
           makes somebody check they are in the right place. */
        title={
          lockedNodeType
            ? `New ${(KINDS.find(([v]) => v === lockedNodeType)?.[1] ?? 'asset').toLowerCase()}`
            : 'Document an asset'
        }
        icon={Server}
        size="lg"
      >
        <form onSubmit={submit} className="space-y-4">

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Hidden when the caller already said what this is — see
                lockedNodeType. The field below then takes the full row. */}
            {!lockedNodeType && (
              <div>
                <Label htmlFor="asset-type">Kind</Label>
                <Select
                  id="asset-type"
                  value={nodeType}
                  onChange={(e) => {
                    setNodeType(e.target.value);
                    setExtra('');
                  }}
                >
                  {KINDS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {!NAME_IS_EXTRA.has(nodeType) && (
              <div>
                <Label htmlFor="asset-name">Name</Label>
                <Input
                  id="asset-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={NAME_PLACEHOLDER[nodeType] ?? ''}
                  required
                  autoFocus
                  maxLength={200}
                />
              </div>
            )}

            {field && (
              <div>
                <Label htmlFor="asset-extra">{field.label}</Label>
                {field.options ? (
                  <Select
                    id="asset-extra"
                    value={extraValue}
                    onChange={(e) => setExtra(e.target.value)}
                  >
                    {field.options.map((o) => (
                      <option key={o} value={o}>
                        {humanise(o)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id="asset-extra"
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                    required
                    spellCheck={false}
                    autoFocus={NAME_IS_EXTRA.has(nodeType)}
                    maxLength={NAME_IS_EXTRA.has(nodeType) ? 200 : undefined}
                  />
                )}
                {field.hint && <FieldHint>{field.hint}</FieldHint>}
              </div>
            )}

            {sites.length > 0 && (
              <div>
                <Label htmlFor="asset-site">Site</Label>
                <Select id="asset-site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                  <option value="">Not at a specific site</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {detailFields.length > 0 && (
            <fieldset className="space-y-2 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium text-ink">{humanise(nodeType)} details</legend>
              <DetailFieldInputs
                fields={detailFields}
                draft={detail}
                set={(k, v) => setDetail((d) => ({ ...d, [k]: v }))}
                idPrefix="create-detail"
              />
            </fieldset>
          )}

          {/*
            The fields every kind shares, asked for up front so nobody has to
            open the entry straight after creating it to say how critical it
            is. Each kind's own fields stay in its Details editor.
          */}
          <div>
            <Label htmlFor="asset-description">Description</Label>
            <Input
              id="asset-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              placeholder="Optional. One line: what it is for."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="asset-status">Status</Label>
              <Select id="asset-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {NODE_STATUSES.map((s) => (
                  <option key={s} value={s}>{humanise(s)}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="asset-criticality">Criticality</Label>
              <Select
                id="asset-criticality"
                value={String(criticality)}
                onChange={(e) => setCriticality(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </Select>
              <FieldHint>5 is “the business stops”.</FieldHint>
            </div>
            <div>
              <Label htmlFor="asset-tags">Tags</Label>
              <Input
                id="asset-tags"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                placeholder="comma, separated"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="asset-notes">Notes</Label>
            <Textarea
              id="asset-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="Optional. Anything the next person opening this would want to know."
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={busy || (!NAME_IS_EXTRA.has(nodeType) && !name.trim()) || (field !== null && !extraValue.trim())}
          >
            {busy && <Loader2 className="animate-spin" />}
            {busy ? 'Creating…' : 'Create asset'}
          </Button>
        </form>
      </Modal>
    </>
  );
}
