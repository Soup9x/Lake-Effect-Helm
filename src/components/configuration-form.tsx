'use client';

/**
 * A configuration, the way a technician fills one in: five sections, one
 * save (0800).
 *
 *   Configuration — name, type, status, the three dates, notes
 *   Purchase      — when, from whom, serial, asset tag, make and model
 *   Location      — site, contact, install date and by whom, where it sits
 *   Device        — hostname, addresses, platform and OS
 *   Interfaces    — as many as it has; one primary, each with what it is
 *                   connected to
 *
 * ONE FORM FOR NEW AND EDIT. Edit fetches GET /api/devices/:id when it opens
 * rather than carrying the whole device in every list row. Both modes save
 * everything in one request so a refusal anywhere leaves nothing half-done.
 *
 * The device fields are the detail catalogue's (lib/assets/detail-fields),
 * laid out by section here; the route writes them through the same casts as
 * the generic Edit details, so the two cannot disagree.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Server, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Modal } from './ui/modal';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { apiFetch } from '@/lib/ui/api';
import { humanise, toDateTimeLocalInput } from '@/lib/ui/format';
import { DEVICE_TYPES, detailFieldsFor, type DetailField } from '@/lib/assets/detail-fields';

const STATUSES = ['active', 'inactive', 'retired', 'planned', 'maintenance'] as const;

interface InterfaceDraft {
  name: string; ipAddress: string; macAddress: string; port: string; isPrimary: boolean; notes: string; connectedToNodeId: string;
}
const emptyInterface = (primary: boolean): InterfaceDraft =>
  ({ name: '', ipAddress: '', macAddress: '', port: '', isPrimary: primary, notes: '', connectedToNodeId: '' });

interface DeviceView {
  name: string; status: string; siteId: string | null; notes: string | null; contactId: string | null;
  detail: Record<string, unknown>;
  interfaces: { name: string | null; ipAddress: string | null; macAddress: string | null; port: string | null;
    isPrimary: boolean; notes: string | null; connectedToNodeId: string | null }[];
}

const SECTIONS: { title: string; keys: string[] }[] = [
  { title: 'Configuration information', keys: ['warranty_expires_at', 'end_of_life_at'] },
  { title: 'Purchase information', keys: ['purchased_at', 'purchased_by', 'serial_number', 'asset_tag', 'manufacturer', 'model'] },
  { title: 'Location information', keys: ['installed_at', 'installed_by', 'physical_position'] },
  { title: 'Device information', keys: ['hostname', 'primary_ip', 'primary_mac', 'default_gateway', 'platform', 'operating_system', 'os_version', 'os_notes', 'fqdn', 'management_url', 'cpu', 'memory_gb', 'storage_gb', 'rmm_device_id', 'backup_policy', 'monitoring_enabled'] },
];

const host = (v: string) => v.replace(/\/(32|128)$/, '');

/** The device catalogue, minus the type, which has its own select above. */
const FIELDS = detailFieldsFor('device').filter((f) => f.key !== 'device_type');
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

function draftOf(fields: readonly DetailField[], detail: Record<string, unknown>): Record<string, string | boolean> {
  const d: Record<string, string | boolean> = {};
  for (const f of fields) {
    const v = detail[f.key];
    if (f.kind === 'boolean') d[f.key] = v === true;
    else if (f.kind === 'date') d[f.key] = typeof v === 'string' ? v.slice(0, 10) : '';
    else if (f.kind === 'datetime') d[f.key] = typeof v === 'string' ? toDateTimeLocalInput(v) : '';
    else if (f.kind === 'text_list' || f.kind === 'inet_list') d[f.key] = Array.isArray(v) ? v.join('\n') : '';
    else d[f.key] = v === null || v === undefined ? '' : f.pg === 'inet' ? host(String(v)) : String(v);
  }
  return d;
}

export function ConfigurationForm({
  organizationId,
  deviceId,
  open,
  onOpenChange,
  sites,
  contacts,
  connectable,
}: {
  organizationId: string;
  /** Set to edit that device; absent to create one. */
  deviceId?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: readonly { id: string; name: string }[];
  contacts: readonly { id: string; name: string }[];
  /** Devices and networks of this client an interface can connect to. */
  connectable: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const editing = deviceId !== undefined;
  const fields = FIELDS;
  const byKey = BY_KEY;

  const [name, setName] = useState('');
  const [deviceType, setDeviceType] = useState<string>('server');
  const [status, setStatus] = useState<string>('active');
  const [siteId, setSiteId] = useState('');
  const [contactId, setContactId] = useState('');
  const [notes, setNotes] = useState('');
  const [detail, setDetail] = useState<Record<string, string | boolean>>(() => draftOf(fields, {}));
  const [interfaces, setInterfaces] = useState<InterfaceDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName(''); setDeviceType('server'); setStatus('active'); setSiteId(''); setContactId(''); setNotes('');
    setDetail(draftOf(fields, {})); setInterfaces([]); setError(null);
  }

  useEffect(() => {
    if (!open || !editing) return;
    let cancelled = false;
    setLoading(true);
    void apiFetch<{ device: DeviceView }>(`/api/devices/${deviceId}`, { method: 'GET' }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) { setError(result.message); return; }
      const d = result.value!.device;
      setName(d.name); setStatus(d.status); setSiteId(d.siteId ?? ''); setContactId(d.contactId ?? '');
      setNotes(d.notes ?? '');
      setDeviceType(String(d.detail.device_type ?? 'server'));
      setDetail(draftOf(fields, d.detail));
      setInterfaces(d.interfaces.map((i) => ({
        name: i.name ?? '', ipAddress: i.ipAddress ?? '', macAddress: i.macAddress ?? '', port: i.port ?? '',
        isPrimary: i.isPrimary, notes: i.notes ?? '', connectedToNodeId: i.connectedToNodeId ?? '',
      })));
    });
    return () => { cancelled = true; };
  }, [open, editing, deviceId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const detailPayload: Record<string, unknown> = {};
      for (const f of fields) {
        const v = detail[f.key];
        detailPayload[f.key] = f.kind === 'boolean' ? v === true : String(v ?? '').trim();
      }
      const payload = {
        name: name.trim(),
        deviceType,
        status,
        siteId: siteId === '' ? null : siteId,
        contactId: contactId === '' ? null : contactId,
        notes: notes.trim() === '' ? null : notes.trim(),
        detail: detailPayload,
        interfaces: interfaces.map((i) => ({
          name: i.name.trim() || null, ipAddress: i.ipAddress.trim() || null, macAddress: i.macAddress.trim() || null,
          port: i.port.trim() || null, isPrimary: i.isPrimary, notes: i.notes.trim() || null,
          connectedToNodeId: i.connectedToNodeId || null,
        })),
      };
      const result = editing
        ? await apiFetch<{ device: { id: string } }>(`/api/devices/${deviceId}`, { method: 'PATCH', json: payload })
        : await apiFetch<{ device: { id: string } }>('/api/devices', { json: { organizationId, ...payload } });
      if (!result.ok) { setError(result.message); return; }
      onOpenChange(false);
      if (!editing && result.value?.device.id) router.push(`/assets/${result.value.device.id}`);
      else router.refresh();
      reset();
    } finally {
      setBusy(false);
    }
  }

  const setField = (key: string, value: string | boolean) => setDetail((d) => ({ ...d, [key]: value }));
  const setIface = (i: number, patch: Partial<InterfaceDraft>) =>
    setInterfaces((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  function renderField(key: string) {
    const f = byKey.get(key);
    if (!f) return null;
    const id = `cfg-${f.key}`;
    const value = detail[f.key];
    if (f.kind === 'boolean') {
      return (
        <label key={f.key} htmlFor={id} className="flex items-center gap-2 pt-5 text-sm text-ink">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => setField(f.key, e.target.checked)} />
          {f.label}
        </label>
      );
    }
    const wide = f.kind === 'textarea';
    return (
      <div key={f.key} className={wide ? 'sm:col-span-2' : undefined}>
        <Label htmlFor={id}>{f.label}</Label>
        {f.kind === 'select' ? (
          <Select id={id} value={String(value ?? '')} onChange={(e) => setField(f.key, e.target.value)}>
            <option value="">—</option>
            {f.options?.map((o) => <option key={o} value={o}>{humanise(o)}</option>)}
          </Select>
        ) : wide ? (
          <Textarea id={id} rows={2} value={String(value ?? '')} onChange={(e) => setField(f.key, e.target.value)} />
        ) : (
          <Input
            id={id}
            type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
            {...(f.kind === 'number' && f.pg === 'numeric' ? { step: 'any' } : {})}
            value={String(value ?? '')}
            onChange={(e) => setField(f.key, e.target.value)}
          />
        )}
        {f.hint && <FieldHint>{f.hint}</FieldHint>}
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { onOpenChange(next); if (!next) reset(); }}
      title={editing ? 'Edit configuration' : 'New configuration'}
      description="A server, workstation, firewall, printer — anything with a serial number."
      icon={Server}
      size="lg"
    >
      <form onSubmit={save} className="space-y-6">
        {loading && <p className="text-sm text-ink-faint">Loading…</p>}

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Configuration information</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="cfg-name">Name *</Label>
              <Input id="cfg-name" value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="cfg-type">Type *</Label>
              <Select id="cfg-type" value={deviceType} onChange={(e) => setDeviceType(e.target.value)}>
                {DEVICE_TYPES.map((t) => <option key={t} value={t}>{humanise(t)}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="cfg-status">Status *</Label>
              <Select id="cfg-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
              </Select>
            </div>
            {SECTIONS[0]!.keys.map(renderField)}
            <div className="sm:col-span-2">
              <Label htmlFor="cfg-notes">Notes</Label>
              <Textarea id="cfg-notes" rows={2} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Purchase information</h3>
          <div className="grid gap-3 sm:grid-cols-2">{SECTIONS[1]!.keys.map(renderField)}</div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Location information</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="cfg-site">Location</Label>
              <Select id="cfg-site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">—</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="cfg-contact">Contact</Label>
              <Select id="cfg-contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">—</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            {SECTIONS[2]!.keys.map(renderField)}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Device information</h3>
          <div className="grid gap-3 sm:grid-cols-2">{SECTIONS[3]!.keys.map(renderField)}</div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">Interfaces</h3>
          {interfaces.map((entry, i) => (
            <div key={i} className="space-y-2 rounded border border-border p-2">
              <div className="grid gap-2 sm:grid-cols-4">
                <Input aria-label={`Interface ${i + 1} name`} placeholder="Name / slot" value={entry.name} maxLength={80}
                       onChange={(e) => setIface(i, { name: e.target.value })} />
                <Input aria-label={`Interface ${i + 1} IP`} placeholder="IP address" value={entry.ipAddress} maxLength={64}
                       onChange={(e) => setIface(i, { ipAddress: e.target.value })} />
                <Input aria-label={`Interface ${i + 1} MAC`} placeholder="MAC address" value={entry.macAddress} maxLength={32}
                       onChange={(e) => setIface(i, { macAddress: e.target.value })} />
                <Input aria-label={`Interface ${i + 1} port`} placeholder="Port" value={entry.port} maxLength={40}
                       onChange={(e) => setIface(i, { port: e.target.value })} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label={`Interface ${i + 1} connected to`} value={entry.connectedToNodeId} className="w-auto min-w-48"
                        onChange={(e) => setIface(i, { connectedToNodeId: e.target.value })}>
                  <option value="">Connected to…</option>
                  {connectable.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </Select>
                <Input aria-label={`Interface ${i + 1} notes`} placeholder="Notes" value={entry.notes} maxLength={2000}
                       className="min-w-40 flex-1" onChange={(e) => setIface(i, { notes: e.target.value })} />
                <label className="flex items-center gap-1 text-xs text-ink-muted">
                  <input type="radio" name="primary-interface" checked={entry.isPrimary}
                         onChange={() => setInterfaces((l) => l.map((x, j) => ({ ...x, isPrimary: j === i })))} />
                  Primary
                </label>
                <button type="button" className="rounded p-1 text-ink-faint hover:text-danger"
                        onClick={() => setInterfaces((l) => l.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" aria-hidden />
                  <span className="sr-only">Remove interface {i + 1}</span>
                </button>
              </div>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" disabled={interfaces.length >= 32}
                  onClick={() => setInterfaces((l) => [...l, emptyInterface(l.length === 0)])}>
            <Plus className="size-3.5" aria-hidden /> Add an interface
          </Button>
          <FieldHint>The primary interface's address and MAC become the device's. A connection draws a link in the graph.</FieldHint>
        </section>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="cta" size="sm" disabled={busy || loading || !name.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            {editing ? 'Save changes' : 'Create configuration'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
