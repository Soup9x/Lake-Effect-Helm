'use client';

/**
 * Proxmox (1110): which clusters are connected, the client each imports to,
 * what each has imported, and the form that connects one.
 *
 * The certificate is the part people trip on. Proxmox ships a self-signed
 * one, so the form offers to fetch what the address presents and trust that
 * exact certificate. Left blank, Helm trusts the certificates this server's
 * CAs vouch for, which is right once Proxmox has a real one.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, RefreshCw, ServerCog, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Badge, type BadgeTone } from './ui/badge';
import { Modal } from './ui/modal';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { formatDateTime } from '@/lib/ui/format';
import { apiFetch, type Feedback } from '@/lib/ui/api';
import type { ProxmoxConnection } from '@/lib/proxmox/queries';
import type { CertificateInfo } from '@/lib/net/pinned-https';

interface OrganizationOption {
  id: string;
  name: string;
}

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  configured: { label: 'Waiting for first sync', tone: 'neutral' },
  active: { label: 'Syncing', tone: 'ok' },
  degraded: { label: 'Failing', tone: 'warning' },
  error: { label: 'Failing repeatedly', tone: 'danger' },
  disabled: { label: 'Off', tone: 'neutral' },
};

interface Draft {
  organizationId: string;
  name: string;
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  tlsSha256: string;
  syncEnabled: boolean;
  interval: string;
}

const blank = (internalOrganizationId: string | null): Draft => ({
  organizationId: internalOrganizationId ?? '',
  name: '',
  baseUrl: '',
  tokenId: 'helm@pve!helm',
  tokenSecret: '',
  tlsSha256: '',
  syncEnabled: true,
  interval: '60',
});

const draftOf = (c: ProxmoxConnection): Draft => ({
  organizationId: c.organizationId,
  name: c.name,
  baseUrl: c.baseUrl,
  tokenId: c.tokenId,
  tokenSecret: '',
  tlsSha256: c.tlsSha256 ?? '',
  syncEnabled: c.syncEnabled,
  interval: String(c.intervalMinutes),
});

const normalise = (v: string) => v.replace(/[\s:]/g, '').toLowerCase();
/** AB:CD:… the way Proxmox shows a fingerprint, so the two can be compared by eye. */
const colons = (hex: string) => hex.toUpperCase().match(/.{1,2}/g)?.join(':') ?? hex;

export function ProxmoxSettingsCard({
  initial, organizations, canManage, internalOrganizationId,
}: {
  initial: ProxmoxConnection[];
  organizations: OrganizationOption[];
  canManage: boolean;
  internalOrganizationId: string | null;
}) {
  const router = useRouter();
  const [connections, setConnections] = useState(initial);
  const [editing, setEditing] = useState<ProxmoxConnection | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank(internalOrganizationId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; remedy: string | null } | null>(null);
  const [certificate, setCertificate] = useState<CertificateInfo | null>(null);
  const [certBusy, setCertBusy] = useState(false);
  const [notice, setNotice] = useState<Feedback>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const secretNeeded = !editing || editing.baseUrl !== draft.baseUrl.trim().replace(/\/+$/, '')
    || (editing.tlsSha256 ?? '') !== normalise(draft.tlsSha256) || editing.tokenId !== draft.tokenId.trim();

  function openNew() {
    setEditing(null);
    setDraft(blank(internalOrganizationId));
    setError(null);
    setCertificate(null);
    setOpen(true);
  }

  function openEdit(c: ProxmoxConnection) {
    setEditing(c);
    setDraft(draftOf(c));
    setError(null);
    setCertificate(null);
    setOpen(true);
  }

  async function fetchCertificate() {
    setCertBusy(true);
    setError(null);
    setCertificate(null);
    try {
      const result = await apiFetch<{ certificate: CertificateInfo }>('/api/integrations/proxmox/certificate', {
        method: 'POST',
        json: { baseUrl: draft.baseUrl.trim() },
      });
      if (!result.ok) {
        const remedy = result.details?.remedy;
        setError({ message: result.message, remedy: typeof remedy === 'string' ? remedy : null });
        return;
      }
      setCertificate(result.value.certificate);
    } finally {
      setCertBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{
        connections: ProxmoxConnection[];
        tested?: { version: string | null; cluster: string | null; hosts: number };
      }>('/api/integrations/proxmox', {
        method: 'PUT',
        json: {
          ...(editing ? { id: editing.id } : {}),
          organizationId: draft.organizationId,
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
          baseUrl: draft.baseUrl.trim(),
          tokenId: draft.tokenId.trim(),
          ...(draft.tokenSecret.trim() ? { tokenSecret: draft.tokenSecret.trim() } : {}),
          tlsSha256: draft.tlsSha256.trim() ? draft.tlsSha256.trim() : null,
          syncEnabled: draft.syncEnabled,
          intervalMinutes: Number(draft.interval),
        },
      });
      if (!result.ok) {
        const remedy = result.details?.remedy;
        setError({ message: result.message, remedy: typeof remedy === 'string' ? remedy : null });
        return;
      }
      setConnections(result.value.connections);
      setOpen(false);
      const tested = result.value.tested;
      setNotice({
        ok: true,
        message: tested
          ? `Connected to ${tested.cluster ?? 'Proxmox'}${tested.version ? ` (Proxmox VE ${tested.version})` : ''}, `
            + `${tested.hosts} ${tested.hosts === 1 ? 'host' : 'hosts'}. The first sync starts within a minute.`
          : 'Saved.',
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function syncNow(c: ProxmoxConnection) {
    setRowBusy(c.id);
    try {
      const result = await apiFetch(`/api/integrations/proxmox/${c.id}/sync`, { method: 'POST' });
      setNotice(result.ok
        ? { ok: true, message: `${c.name}: queued. It starts within a minute; refresh to see it.` }
        : { ok: false, message: result.message });
    } finally {
      setRowBusy(null);
    }
  }

  async function remove(c: ProxmoxConnection) {
    if (!window.confirm(`Disconnect ${c.name}? The hosts and VMs it imported stay.`)) return;
    setRowBusy(c.id);
    try {
      const result = await apiFetch<{ connections: ProxmoxConnection[] }>(`/api/integrations/proxmox/${c.id}`, { method: 'DELETE' });
      if (!result.ok) {
        setNotice({ ok: false, message: result.message });
        return;
      }
      setConnections(result.value.connections);
      setNotice({ ok: true, message: `${c.name} disconnected. Its hosts and VMs stay documented.` });
    } finally {
      setRowBusy(null);
    }
  }

  const pinned = normalise(draft.tlsSha256);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerCog className="size-4 text-ink-faint" aria-hidden /> Proxmox
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm text-ink-muted">
            Imports each Proxmox host as a hypervisor and every VM and container as a virtual machine of the
            client you choose, with CPUs, memory, disk, address, operating system and the host it runs on. Status,
            disks, network, snapshots and the last backup show on each one. Templates are left out, names and
            anything somebody edits by hand stay as they left them, nothing is written to Proxmox, and a VM removed
            there stays documented here.
          </p>
          {canManage && (
            <Button variant="secondary" size="sm" onClick={openNew}>
              <Plus className="size-4" aria-hidden /> Connect a cluster
            </Button>
          )}
        </div>

        {notice && (
          <p role={notice.ok ? undefined : 'alert'} className={notice.ok ? 'text-sm text-ok' : 'text-sm text-danger'}>
            {notice.message}
          </p>
        )}

        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Cluster</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Hosts</TableHead>
              <TableHead className="text-right">VMs</TableHead>
              <TableHead>Last synced</TableHead>
              {canManage && <TableHead className="sr-only">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.length === 0 && (
              <TableEmpty colSpan={canManage ? 7 : 6}>No Proxmox cluster is connected.</TableEmpty>
            )}
            {connections.map((c) => {
              const status = STATUS[c.status] ?? { label: c.status, tone: 'neutral' as BadgeTone };
              const partial = c.lastRun?.status === 'partial' && c.status === 'active';
              const problem = c.lastError ?? (c.lastRun?.status === 'partial' ? c.lastRun.error : null);
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <span className="font-medium">{c.name}</span>
                    <span className="block text-xs text-ink-faint">
                      {c.baseUrl}
                      {c.tlsSha256 && (
                        <span className="ml-1 inline-flex items-center gap-0.5" title={`Trusts only the certificate ${colons(c.tlsSha256)}`}>
                          · <ShieldCheck className="size-3" aria-hidden /> pinned
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-ink-muted">{c.organizationName}</TableCell>
                  <TableCell>
                    <Badge tone={partial ? 'warning' : status.tone}>{partial ? 'Partly syncing' : status.label}</Badge>
                    {problem && <span className="mt-1 block max-w-sm text-xs text-ink-muted">{problem}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.hosts}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.guests}</TableCell>
                  <TableCell className="text-ink-muted">
                    {c.lastSuccessAt ? formatDateTime(c.lastSuccessAt) : 'Not yet'}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => syncNow(c)}
                          disabled={rowBusy === c.id || !c.syncEnabled} aria-label={`Sync ${c.name} now`}>
                          {rowBusy === c.id ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>Edit</Button>
                        <Button variant="ghost" size="sm" onClick={() => remove(c)} disabled={rowBusy === c.id}
                          aria-label={`Disconnect ${c.name}`}>
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {!canManage && <p className="text-xs text-ink-faint">Connecting Proxmox requires hypervisor integration access.</p>}

        <Modal open={open} onOpenChange={setOpen} icon={ServerCog} size="lg"
          title={editing ? `Proxmox: ${editing.name}` : 'Connect a Proxmox cluster'}>
          <form onSubmit={save} className="space-y-4">
            <FieldHint>
              In Proxmox, add a user (for example helm@pve) under Datacenter → Permissions → Users, give it the
              PVEAuditor role on /, then add an API token for it with Privilege Separation unticked. Helm only
              reads; the token cannot change anything.
            </FieldHint>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="pve-org">Imports to client</Label>
                <Select id="pve-org" required value={draft.organizationId}
                  onChange={(e) => set('organizationId', e.target.value)}>
                  <option value="">Choose…</option>
                  {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
                <FieldHint>Whose servers these are. Every host and VM goes to this client.</FieldHint>
              </div>
              <div>
                <Label htmlFor="pve-name">Name (optional)</Label>
                <Input id="pve-name" maxLength={120} placeholder="The cluster's name"
                  value={draft.name} onChange={(e) => set('name', e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="pve-url">Address</Label>
                <Input id="pve-url" type="url" inputMode="url" required autoComplete="off"
                  placeholder="https://pve.example.com:8006"
                  value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
                <FieldHint>Any host of the cluster, with the port. This server has to be able to reach it.</FieldHint>
              </div>
              <div>
                <Label htmlFor="pve-token-id">Token ID</Label>
                <Input id="pve-token-id" required autoComplete="off" placeholder="helm@pve!helm"
                  value={draft.tokenId} onChange={(e) => set('tokenId', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="pve-token-secret">Token secret</Label>
                <Input id="pve-token-secret" type="password" autoComplete="new-password"
                  required={secretNeeded}
                  placeholder={!secretNeeded ? 'Stored — leave blank to keep it' : undefined}
                  value={draft.tokenSecret} onChange={(e) => set('tokenSecret', e.target.value)} />
                <FieldHint>
                  {editing && secretNeeded
                    ? 'Needed again because the address, certificate or token ID changed.'
                    : 'Kept in the vault, in your own organisation. Tried before it is saved.'}
                </FieldHint>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pve-pin">Trusted certificate (SHA-256 fingerprint)</Label>
              <div className="flex flex-wrap gap-2">
                <Input id="pve-pin" className="min-w-0 flex-1 font-mono text-xs" autoComplete="off"
                  placeholder="Blank: trust certificates this server's CAs vouch for"
                  value={draft.tlsSha256} onChange={(e) => set('tlsSha256', e.target.value)} />
                <Button type="button" variant="secondary" size="sm" onClick={fetchCertificate}
                  disabled={certBusy || !draft.baseUrl.trim()}>
                  {certBusy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Fetch from server
                </Button>
              </div>
              <FieldHint>
                Proxmox&rsquo;s own certificate is self-signed, so give its fingerprint here; Helm then trusts that
                certificate and no other. Proxmox shows it under the host → System → Certificates. If you later
                install a certificate from a real CA, clear this.
              </FieldHint>
              {certificate && (
                <div className="space-y-1 rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs">
                  <p className="text-ink">
                    {certificate.subject} · issued by {certificate.issuer}
                    {certificate.selfSigned && <Badge tone="neutral" className="ml-2">Self-signed</Badge>}
                    {certificate.trusted && <Badge tone="ok" className="ml-2">Trusted by this server</Badge>}
                  </p>
                  <p className="break-all font-mono text-ink-muted">{colons(certificate.sha256)}</p>
                  <p className="text-ink-faint">Valid until {certificate.validTo}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button type="button" variant="secondary" size="sm" disabled={pinned === certificate.sha256}
                      onClick={() => set('tlsSha256', certificate.sha256)}>
                      <ShieldCheck className="size-4" aria-hidden />
                      {pinned === certificate.sha256 ? 'Trusted' : 'Trust this certificate'}
                    </Button>
                    {certificate.trusted && pinned && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => set('tlsSha256', '')}>
                        Use the CAs instead
                      </Button>
                    )}
                  </div>
                  <p className="text-ink-faint">
                    Compare it with what Proxmox shows before trusting it: a different fingerprint means
                    something else is answering at this address.
                  </p>
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="pve-interval">Sync every (minutes)</Label>
                <Input id="pve-interval" type="number" inputMode="numeric" min={15} max={10080} required
                  value={draft.interval} onChange={(e) => set('interval', e.target.value)} />
                <FieldHint>15 to 10080 (a week).</FieldHint>
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm text-ink">
                <input type="checkbox" checked={draft.syncEnabled} onChange={(e) => set('syncEnabled', e.target.checked)}
                  className="size-4 rounded border-border-strong" />
                Sync on a schedule
              </label>
            </div>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error.message}
                {error.remedy && <span className="block text-xs text-ink-muted">{error.remedy}</span>}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {draft.tokenSecret.trim() ? 'Test and save' : 'Save'}
              </Button>
            </div>
          </form>
        </Modal>
      </CardContent>
    </Card>
  );
}
