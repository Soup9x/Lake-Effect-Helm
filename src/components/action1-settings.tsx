'use client';

/**
 * Action1 (1160): the connection, which client each Action1 organization
 * imports to, and how the last few runs went.
 *
 * Three steps, in the order they have to happen: save the API credential
 * (tried against Action1 before anything is stored, which also fetches the
 * organization list), choose a client for each organization, then sync.
 *
 * "New client" maps an organization to a client of the same name, created on
 * save if Helm has none yet, so an MSP starting out does not have to type in
 * every client first.
 *
 * An MSP can have hundreds of Action1 organizations, so the table filters by
 * where each stands (not decided, importing, not importing), searches by
 * either name, and sorts by name or device count. All of it in the browser:
 * the whole list is already here.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Badge, type BadgeTone } from './ui/badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from './ui/table';
import { formatDateTime } from '@/lib/ui/format';
import { apiFetch, type Feedback } from '@/lib/ui/api';
import { ACTION1_REGIONS } from '@/lib/action1/client';
import type { Action1Settings } from '@/lib/action1/queries';

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

type OrgFilter = 'all' | 'undecided' | 'importing' | 'excluded';
type OrgSort = 'name' | 'devices';

/** Where an organization stands, by what is saved rather than what is being edited. */
function standingOf(org: Action1Settings['organizations'][number]): Exclude<OrgFilter, 'all'> {
  if (org.organizationId && !org.organizationArchived) return 'importing';
  return org.organizationId || org.excludedAt ? 'excluded' : 'undecided';
}

const RUN_TONE: Record<string, BadgeTone> = {
  success: 'ok', partial: 'warning', failed: 'danger', running: 'brand', queued: 'neutral', cancelled: 'neutral',
};

/** The mapping value that asks for a client named like the Action1 organization. */
const NEW_CLIENT = 'new';
const DONT_IMPORT = 'none';

export function Action1SettingsCard({
  initial, organizations: organizationOptions, canManage, canCreateClients, internalOrganizationId,
}: {
  initial: Action1Settings;
  organizations: OrganizationOption[];
  canManage: boolean;
  canCreateClients: boolean;
  internalOrganizationId: string | null;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const connection = settings.connection;

  const [baseUrl, setBaseUrl] = useState<string>(connection?.baseUrl ?? ACTION1_REGIONS[0].url);
  const [clientId, setClientId] = useState(connection?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(connection?.syncEnabled ?? true);
  const [interval, setIntervalMinutes] = useState(String(connection?.intervalMinutes ?? 60));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [remedy, setRemedy] = useState<string | null>(null);

  // '' is nobody has decided; DONT_IMPORT is somebody chose not to.
  const mappingOf = (s: Action1Settings) =>
    Object.fromEntries(s.organizations.map((o) =>
      [o.action1OrgId, o.organizationId ?? (o.excludedAt ? DONT_IMPORT : '')]));
  const [mapping, setMapping] = useState<Record<string, string>>(mappingOf(initial));
  const [mappingBusy, setMappingBusy] = useState(false);
  const [mappingFeedback, setMappingFeedback] = useState<Feedback>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [orgFilter, setOrgFilter] = useState<OrgFilter>(() =>
    initial.organizations.some((o) => standingOf(o) === 'undecided') ? 'undecided' : 'all');
  const [orgQuery, setOrgQuery] = useState('');
  const [orgSort, setOrgSort] = useState<OrgSort>('name');

  // Clients created by the last save are mapped before the page's list is
  // refreshed; without them a select would show a value it has no option for.
  const organizations = [
    ...organizationOptions,
    ...settings.organizations
      .filter((o) => o.organizationId && o.organizationName
        && !organizationOptions.some((opt) => opt.id === o.organizationId))
      .map((o) => ({ id: o.organizationId!, name: o.organizationName! })),
  ].filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i);

  const savedMapping = mappingOf(settings);
  const mappingDirty = Object.keys(mapping).some((k) => mapping[k] !== savedMapping[k]);

  function adopt(next: Action1Settings) {
    setSettings(next);
    setMapping(mappingOf(next));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    setRemedy(null);
    try {
      const result = await apiFetch<Action1Settings & { tested?: { organizations: number } }>('/api/integrations/action1', {
        method: 'PUT',
        json: {
          baseUrl,
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          syncEnabled,
          intervalMinutes: Number(interval),
        },
      });
      if (!result.ok) {
        setFeedback({ ok: false, message: result.message });
        const hint = result.details?.remedy;
        setRemedy(typeof hint === 'string' ? hint : null);
        return;
      }
      adopt(result.value);
      setClientSecret('');
      const tested = result.value.tested;
      setFeedback({
        ok: true,
        message: tested
          ? `Saved. Action1 answered and listed ${tested.organizations} ${tested.organizations === 1 ? 'organization' : 'organizations'} — choose a client for each below.`
          : 'Saved.',
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function saveMapping() {
    setMappingBusy(true);
    setMappingFeedback(null);
    try {
      const changed = Object.keys(mapping)
        .filter((k) => mapping[k] !== savedMapping[k])
        .map((k) => ({ action1OrgId: k, organizationId: mapping[k] === DONT_IMPORT ? null : mapping[k] || null }));
      const result = await apiFetch<Action1Settings>('/api/integrations/action1/organizations', {
        method: 'PUT',
        json: { mappings: changed },
      });
      if (!result.ok) {
        setMappingFeedback({ ok: false, message: result.message });
        return;
      }
      adopt(result.value);
      setMappingFeedback({ ok: true, message: 'Saved. Endpoints import on the next sync.' });
      if (changed.some((c) => c.organizationId === NEW_CLIENT)) router.refresh();
    } finally {
      setMappingBusy(false);
    }
  }

  /**
   * Every organization shown that nobody has decided on, or that imports to the
   * MSP's own. Not one somebody chose not to import: that is a decision, and
   * this would quietly undo it — or recreate a client they deleted.
   */
  function newClientForEach() {
    const target = new Set(shownOrgs.map((o) => o.action1OrgId));
    setMapping((m) => Object.fromEntries(Object.entries(m).map(([k, v]) =>
      [k, target.has(k) && (v === '' || v === internalOrganizationId) ? NEW_CLIENT : v])));
  }

  async function syncNow() {
    setSyncBusy(true);
    setMappingFeedback(null);
    try {
      const result = await apiFetch('/api/integrations/action1/sync', { method: 'POST' });
      setMappingFeedback(result.ok
        ? { ok: true, message: 'Queued. The sync starts within a minute; refresh to see it here.' }
        : { ok: false, message: result.message });
    } finally {
      setSyncBusy(false);
    }
  }

  const status = connection ? STATUS[connection.status] ?? { label: connection.status, tone: 'neutral' as BadgeTone } : null;
  const counts = { all: settings.organizations.length, undecided: 0, importing: 0, excluded: 0 };
  for (const org of settings.organizations) counts[standingOf(org)] += 1;
  const query = orgQuery.trim().toLowerCase();
  const shownOrgs = settings.organizations
    .filter((o) => orgFilter === 'all' || standingOf(o) === orgFilter)
    .filter((o) => !query || o.name.toLowerCase().includes(query)
      || (o.organizationName ?? '').toLowerCase().includes(query))
    .sort((a, b) => orgSort === 'devices'
      ? (b.deviceCount ?? -1) - (a.deviceCount ?? -1) || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-ink-faint" aria-hidden /> Action1
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="max-w-3xl space-y-1 text-sm">
          <p className="text-ink-muted">
            Imports the endpoints Action1 manages as configurations of the client you choose for each
            Action1 organization, and keeps their hostname, operating system, hardware, address and
            last check-in current. Missing updates, reboot status, last user and vulnerabilities show
            on the device. A machine already documented, by hand or by NinjaOne, is linked by serial
            number or hostname rather than doubled. Names, notes, status, site and contact are yours,
            and so is any field somebody edits by hand. Nothing is written to Action1, and an endpoint
            removed there stays documented here.
          </p>
          {connection && (
            <p className="text-ink-faint">
              {connection.deviceCount} {connection.deviceCount === 1 ? 'endpoint' : 'endpoints'} linked
              {connection.lastSuccessAt ? ` · last synced ${formatDateTime(connection.lastSuccessAt)}` : ' · not synced yet'}
              {connection.syncEnabled ? ` · every ${connection.intervalMinutes} minutes` : ''}
            </p>
          )}
        </div>

        {connection?.lastError && (
          <p role="alert" className="max-w-3xl rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {connection.lastError}
            {connection.consecutiveFailures > 1 && (
              <span className="block text-xs">
                {connection.consecutiveFailures} failures in a row, so retries are backing off.
              </span>
            )}
          </p>
        )}

        {canManage ? (
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="action1-region">Region</Label>
                <Select id="action1-region" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}>
                  {ACTION1_REGIONS.map((r) => <option key={r.url} value={r.url}>{r.label}</option>)}
                </Select>
                <FieldHint>The address you sign in to Action1 at.</FieldHint>
              </div>
              <div>
                <Label htmlFor="action1-interval">Sync every (minutes)</Label>
                <Input id="action1-interval" type="number" inputMode="numeric" min={15} max={1440} required
                  value={interval} onChange={(e) => setIntervalMinutes(e.target.value)} />
                <FieldHint>15 to 1440.</FieldHint>
              </div>
              <div>
                <Label htmlFor="action1-client-id">Client ID</Label>
                <Input id="action1-client-id" autoComplete="off" required value={clientId}
                  onChange={(e) => setClientId(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="action1-client-secret">Client secret</Label>
                <Input id="action1-client-secret" type="password" autoComplete="new-password"
                  required={!connection?.secretSet}
                  placeholder={connection?.secretSet ? 'Stored — leave blank to keep it' : undefined}
                  value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
                <FieldHint>Kept in the vault like any credential, in your own organization.</FieldHint>
              </div>
            </div>
            <FieldHint className="max-w-3xl">
              In Action1, on the API Credentials page, add a credential (+ New) with a role that
              can view endpoints in every organization (read-only is enough), and copy its client id and secret.
            </FieldHint>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={syncEnabled} onChange={(e) => setSyncEnabled(e.target.checked)}
                className="size-4 rounded border-border-strong" />
              Sync on a schedule
            </label>

            {feedback && (
              <p role={feedback.ok ? undefined : 'alert'} className={feedback.ok ? 'text-sm text-ok' : 'text-sm text-danger'}>
                {feedback.message}
                {remedy && <span className="block text-xs text-ink-muted">{remedy}</span>}
              </p>
            )}

            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {clientSecret.trim() ? 'Save and test' : 'Save'}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-ink-faint">Changing this requires RMM integration access.</p>
        )}

        {connection && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-ink">
                Organizations
                <span className="ml-2 text-xs font-normal text-ink-faint">
                  {counts.importing} of {counts.all} imported
                  {counts.undecided > 0 && ` · ${counts.undecided} not decided`}
                </span>
              </h3>
              {canManage && (
                <div className="flex items-center gap-2">
                  {canCreateClients && (
                    <Button variant="secondary" size="sm" onClick={newClientForEach} disabled={mappingBusy}>
                      New client for each
                    </Button>
                  )}
                  {mappingDirty && (
                    <Button variant="primary" size="sm" onClick={saveMapping} disabled={mappingBusy}>
                      {mappingBusy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      Save clients
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={syncNow}
                    disabled={syncBusy || !connection.syncEnabled || mappingDirty}>
                    {syncBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                    Sync now
                  </Button>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Show" className="w-auto" value={orgFilter}
                onChange={(e) => setOrgFilter(e.target.value as OrgFilter)}>
                <option value="all">All ({counts.all})</option>
                <option value="undecided">Not decided ({counts.undecided})</option>
                <option value="importing">Importing ({counts.importing})</option>
                <option value="excluded">Not importing ({counts.excluded})</option>
              </Select>
              <Input type="search" aria-label="Search organizations" placeholder="Search Action1 or client name"
                className="w-64 max-w-full" value={orgQuery} onChange={(e) => setOrgQuery(e.target.value)} />
              <Select aria-label="Sort by" className="w-auto" value={orgSort}
                onChange={(e) => setOrgSort(e.target.value as OrgSort)}>
                <option value="name">Sort by name</option>
                <option value="devices">Sort by endpoints</option>
              </Select>
            </div>
            {mappingFeedback && (
              <p role={mappingFeedback.ok ? undefined : 'alert'} className={mappingFeedback.ok ? 'text-sm text-ok' : 'text-sm text-danger'}>
                {mappingFeedback.message}
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Action1 organization</TableHead>
                  <TableHead className="text-right">Endpoints</TableHead>
                  <TableHead>Imports to</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settings.organizations.length === 0 && (
                  <TableEmpty colSpan={3}>None yet. They are listed when the connection is saved and on every sync.</TableEmpty>
                )}
                {settings.organizations.length > 0 && shownOrgs.length === 0 && (
                  <TableEmpty colSpan={3}>No organizations match.</TableEmpty>
                )}
                {shownOrgs.map((org) => (
                  <TableRow key={org.action1OrgId}>
                    <TableCell className="font-medium">
                      {org.name}
                      {standingOf(org) === 'undecided' && <Badge tone="brand" className="ml-2">Not decided</Badge>}
                      {org.organizationArchived && <Badge tone="neutral" className="ml-2">Client archived</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-ink-muted">{org.deviceCount ?? '—'}</TableCell>
                    <TableCell>
                      {canManage ? (
                        <Select aria-label={`Client for ${org.name}`} value={mapping[org.action1OrgId] ?? ''}
                          onChange={(e) => setMapping((m) => ({ ...m, [org.action1OrgId]: e.target.value }))}>
                          {(mapping[org.action1OrgId] ?? '') === '' && <option value="">Not decided</option>}
                          <option value={DONT_IMPORT}>Don&rsquo;t import</option>
                          {canCreateClients && <option value={NEW_CLIENT}>New client: {org.name}</option>}
                          {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </Select>
                      ) : (
                        <span className={org.organizationName ? 'text-ink' : 'text-ink-faint'}>
                          {org.organizationName ?? 'Not imported'}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}

        {settings.runs.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-ink">Recent runs</h3>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Started</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Seen</TableHead>
                  <TableHead className="text-right">New</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                  <TableHead className="text-right">Not imported</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settings.runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="text-ink-muted">{run.startedAt ? formatDateTime(run.startedAt) : '—'}</TableCell>
                    <TableCell>
                      <Badge tone={RUN_TONE[run.status] ?? 'neutral'}>{run.status}</Badge>
                      {run.error && <span className="mt-1 block max-w-md text-xs text-ink-muted">{run.error}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{run.seen}</TableCell>
                    <TableCell className="text-right tabular-nums">{run.created}</TableCell>
                    <TableCell className="text-right tabular-nums">{run.updated}</TableCell>
                    <TableCell className="text-right tabular-nums">{run.skipped}</TableCell>
                    <TableCell className="text-right tabular-nums">{run.failed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
