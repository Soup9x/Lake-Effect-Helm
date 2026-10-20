'use client';

/**
 * Microsoft 365 (0990): which clients' tenants are connected, what each has
 * imported, and the form that connects one.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Cloud, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Badge, type BadgeTone } from './ui/badge';
import { Modal } from './ui/modal';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { formatDateTime } from '@/lib/ui/format';
import { apiFetch, type Feedback } from '@/lib/ui/api';
import { GRAPH_PERMISSIONS } from '@/lib/m365/client';
import type { M365Connection } from '@/lib/m365/queries';

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

type SecretMode = 'new' | 'keep' | 'reuse';

interface Draft {
  organizationId: string;
  tenant: string;
  clientId: string;
  clientSecret: string;
  secretMode: SecretMode;
  reuseFrom: string;
  syncEnabled: boolean;
  interval: string;
  syncUsers: boolean;
  syncLicences: boolean;
  syncDomains: boolean;
}

const blank = (connections: M365Connection[]): Draft => {
  const template = connections[0];
  return {
    organizationId: '',
    tenant: '',
    // The usual case is one multi-tenant app for every client: start from it.
    clientId: template?.clientId ?? '',
    clientSecret: '',
    secretMode: template ? 'reuse' : 'new',
    reuseFrom: template?.id ?? '',
    syncEnabled: true,
    interval: '360',
    syncUsers: true,
    syncLicences: true,
    syncDomains: true,
  };
};

const draftOf = (c: M365Connection): Draft => ({
  organizationId: c.organizationId,
  tenant: c.tenant,
  clientId: c.clientId,
  clientSecret: '',
  secretMode: 'keep',
  reuseFrom: '',
  syncEnabled: c.syncEnabled,
  interval: String(c.intervalMinutes),
  syncUsers: c.syncUsers,
  syncLicences: c.syncLicences,
  syncDomains: c.syncDomains,
});

export function M365SettingsCard({
  initial, organizations, canManage,
}: {
  initial: M365Connection[];
  organizations: OrganizationOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [connections, setConnections] = useState(initial);
  const [editing, setEditing] = useState<M365Connection | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; remedy: string | null } | null>(null);
  const [notice, setNotice] = useState<Feedback>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const connected = new Set(connections.map((c) => c.organizationId));
  const reusable = connections.filter((c) => c.secretSet && c.clientId === draft.clientId.trim() && c.id !== editing?.id);

  function openNew() {
    setEditing(null);
    setDraft(blank(connections));
    setError(null);
    setOpen(true);
  }

  function openEdit(c: M365Connection) {
    setEditing(c);
    setDraft(draftOf(c));
    setError(null);
    setOpen(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ connections: M365Connection[]; tested?: { tenantName: string } }>(
        '/api/integrations/m365',
        {
          method: 'PUT',
          json: {
            organizationId: draft.organizationId,
            tenant: draft.tenant.trim(),
            clientId: draft.clientId.trim(),
            ...(draft.secretMode === 'new' ? { clientSecret: draft.clientSecret.trim() } : {}),
            ...(draft.secretMode === 'reuse' ? { reuseSecretFrom: draft.reuseFrom } : {}),
            syncEnabled: draft.syncEnabled,
            intervalMinutes: Number(draft.interval),
            syncUsers: draft.syncUsers,
            syncLicences: draft.syncLicences,
            syncDomains: draft.syncDomains,
          },
        },
      );
      if (!result.ok) {
        const remedy = result.details?.remedy;
        setError({ message: result.message, remedy: typeof remedy === 'string' ? remedy : null });
        return;
      }
      setConnections(result.value.connections);
      setOpen(false);
      const client = organizations.find((o) => o.id === draft.organizationId)?.name ?? 'the client';
      setNotice({
        ok: true,
        message: result.value.tested
          ? `Connected ${client} to “${result.value.tested.tenantName}”. The first sync starts within a minute.`
          : `Saved ${client}.`,
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function syncNow(c: M365Connection) {
    setRowBusy(c.id);
    try {
      const result = await apiFetch(`/api/integrations/m365/${c.id}/sync`, { method: 'POST' });
      setNotice(result.ok
        ? { ok: true, message: `${c.organizationName}: queued. It starts within a minute; refresh to see it.` }
        : { ok: false, message: result.message });
    } finally {
      setRowBusy(null);
    }
  }

  async function remove(c: M365Connection) {
    if (!window.confirm(`Disconnect ${c.organizationName}'s Microsoft 365? What it imported stays.`)) return;
    setRowBusy(c.id);
    try {
      const result = await apiFetch<{ connections: M365Connection[] }>(`/api/integrations/m365/${c.id}`, { method: 'DELETE' });
      if (!result.ok) {
        setNotice({ ok: false, message: result.message });
        return;
      }
      setConnections(result.value.connections);
      setNotice({ ok: true, message: `${c.organizationName} disconnected. Its contacts, licences and domains stay.` });
    } finally {
      setRowBusy(null);
    }
  }

  const check = (key: 'syncUsers' | 'syncLicences' | 'syncDomains' | 'syncEnabled', label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm text-ink">
      <input type="checkbox" checked={draft[key]} onChange={(e) => set(key, e.target.checked)}
        className="mt-0.5 size-4 rounded border-border-strong" />
      <span>
        {label}
        {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
      </span>
    </label>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="size-4 text-ink-faint" aria-hidden /> Microsoft 365
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm text-ink-muted">
            Imports each connected client&rsquo;s licensed users as contacts, their paid subscriptions as
            licences with seats kept current, and their verified domains. Anything somebody edits here by hand
            stays as they left it, nothing is written to Microsoft 365, and a user who leaves stays a contact
            until you archive them.
          </p>
          {canManage && (
            <Button variant="secondary" size="sm" onClick={openNew}>
              <Plus className="size-4" aria-hidden /> Connect a client
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
              <TableHead>Client</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Contacts</TableHead>
              <TableHead className="text-right">Licences</TableHead>
              <TableHead className="text-right">Domains</TableHead>
              <TableHead>Last synced</TableHead>
              {canManage && <TableHead className="sr-only">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.length === 0 && (
              <TableEmpty colSpan={canManage ? 8 : 7}>No client is connected.</TableEmpty>
            )}
            {connections.map((c) => {
              const status = STATUS[c.status] ?? { label: c.status, tone: 'neutral' as BadgeTone };
              const problem = c.lastError ?? (c.lastRun?.status === 'partial' ? c.lastRun.error : null);
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.organizationName}</TableCell>
                  <TableCell className="text-ink-muted">
                    {c.tenantName ?? c.tenant}
                    {c.tenantName && <span className="block font-mono text-xs text-ink-faint">{c.tenant}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge tone={c.lastRun?.status === 'partial' && c.status === 'active' ? 'warning' : status.tone}>
                      {c.lastRun?.status === 'partial' && c.status === 'active' ? 'Partly syncing' : status.label}
                    </Badge>
                    {problem && <span className="mt-1 block max-w-sm text-xs text-ink-muted">{problem}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.syncUsers ? c.contacts : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.syncLicences ? c.licences : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.syncDomains ? c.domains : '—'}</TableCell>
                  <TableCell className="text-ink-muted">
                    {c.lastSuccessAt ? formatDateTime(c.lastSuccessAt) : 'Not yet'}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => syncNow(c)}
                          disabled={rowBusy === c.id || !c.syncEnabled} aria-label={`Sync ${c.organizationName} now`}>
                          {rowBusy === c.id ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>Edit</Button>
                        <Button variant="ghost" size="sm" onClick={() => remove(c)} disabled={rowBusy === c.id}
                          aria-label={`Disconnect ${c.organizationName}`}>
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

        {!canManage && <p className="text-xs text-ink-faint">Connecting clients requires Microsoft 365 integration access.</p>}

        <Modal open={open} onOpenChange={setOpen} icon={Cloud} size="lg"
          title={editing ? `Microsoft 365 for ${editing.organizationName}` : 'Connect a client’s Microsoft 365'}>
          <form onSubmit={save} className="space-y-4">
            <FieldHint>
              Register an app in Entra ID (one multi-tenant app can serve every client), add the application
              permissions {GRAPH_PERMISSIONS.join(', ')}, create a client secret, and grant admin consent in
              the client&rsquo;s tenant.
            </FieldHint>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="m365-org">Client</Label>
                <Select id="m365-org" required disabled={!!editing} value={draft.organizationId}
                  onChange={(e) => set('organizationId', e.target.value)}>
                  <option value="">Choose…</option>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id} disabled={!editing && connected.has(o.id)}>
                      {o.name}{!editing && connected.has(o.id) ? ' (connected)' : ''}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="m365-tenant">Their tenant</Label>
                <Input id="m365-tenant" required placeholder="contoso.onmicrosoft.com or tenant ID"
                  value={draft.tenant} onChange={(e) => set('tenant', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="m365-client-id">Application (client) ID</Label>
                <Input id="m365-client-id" required autoComplete="off" value={draft.clientId}
                  onChange={(e) => set('clientId', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="m365-secret-mode">Client secret</Label>
                <Select id="m365-secret-mode" value={draft.secretMode}
                  onChange={(e) => set('secretMode', e.target.value as SecretMode)}>
                  {editing?.secretSet && <option value="keep">Keep the stored one</option>}
                  <option value="new">Enter a new one</option>
                  {reusable.length > 0 && <option value="reuse">Use the one from another client</option>}
                </Select>
              </div>
            </div>
            {draft.secretMode === 'new' && (
              <div>
                <Label htmlFor="m365-secret">Secret value</Label>
                <Input id="m365-secret" type="password" required autoComplete="new-password"
                  value={draft.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} />
                <FieldHint>The secret&rsquo;s Value, not its ID. Tried against Microsoft before it is saved.</FieldHint>
              </div>
            )}
            {draft.secretMode === 'reuse' && (
              <div>
                <Label htmlFor="m365-reuse">Same app as</Label>
                <Select id="m365-reuse" required value={draft.reuseFrom} onChange={(e) => set('reuseFrom', e.target.value)}>
                  <option value="">Choose…</option>
                  {reusable.map((c) => <option key={c.id} value={c.id}>{c.organizationName}</option>)}
                </Select>
              </div>
            )}

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink">Import</legend>
              {check('syncUsers', 'Users as contacts', 'Enabled, licensed members — not shared mailboxes, rooms or guests.')}
              {check('syncLicences', 'Subscriptions as licences', 'Paid ones, with seats bought and in use.')}
              {check('syncDomains', 'Verified domains')}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="m365-interval">Sync every (minutes)</Label>
                <Input id="m365-interval" type="number" inputMode="numeric" min={30} max={10080} required
                  value={draft.interval} onChange={(e) => set('interval', e.target.value)} />
                <FieldHint>30 to 10080 (a week).</FieldHint>
              </div>
              <div className="pt-6">{check('syncEnabled', 'Sync on a schedule')}</div>
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
                {draft.secretMode === 'new' ? 'Test and save' : 'Save'}
              </Button>
            </div>
          </form>
        </Modal>
      </CardContent>
    </Card>
  );
}
