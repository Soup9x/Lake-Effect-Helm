'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Server, X } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';

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
  ['ip_address', 'IP address'],
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

const humanise = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

interface Site {
  id: string;
  name: string;
}

export function NewAssetForm({
  organizationId,
  sites,
}: {
  organizationId: string;
  sites: Site[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nodeType, setNodeType] = useState<string>('device');
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [extra, setExtra] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setName('');
    setSiteId('');
    setExtra('');
    setNotes('');
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
      case 'ip_address':
        return { label: 'Address', hint: 'IPv4 or IPv6, e.g. 10.10.4.7' };
      case 'domain':
        return { label: 'Domain name', hint: 'e.g. northwind.example' };
      case 'ssl_certificate':
        return { label: 'Common name', hint: 'e.g. www.northwind.example' };
      default:
        return null;
    }
  }

  const field = extraField();
  // A select always has a value; a free-text one starts empty and is required.
  const extraValue = field?.options ? extra || field.options[0]! : extra;

  const EXTRA_KEY: Record<string, string> = {
    device: 'deviceType',
    network: 'networkKind',
    directory_service: 'directoryKind',
    ip_address: 'address',
    domain: 'domainName',
    ssl_certificate: 'commonName',
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = EXTRA_KEY[nodeType];
      const response = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          nodeType,
          name: name.trim(),
          ...(siteId ? { siteId } : {}),
          ...(key ? { [key]: extraValue } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `The asset could not be created (${response.status}).`);
        return;
      }
      close();
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <Plus />
        Document an asset
      </Button>
    );
  }

  return (
    <Card className="mb-4">
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
              <Server className="size-4" />
              Document an asset
            </h2>
            <Button type="button" variant="ghost" size="icon" onClick={close} aria-label="Cancel">
              <X />
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
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

            <div>
              <Label htmlFor="asset-name">Name</Label>
              <Input
                id="asset-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="DC01"
                required
                autoFocus
                maxLength={200}
              />
            </div>

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
            disabled={busy || !name.trim() || (field !== null && !extraValue)}
          >
            {busy && <Loader2 className="animate-spin" />}
            {busy ? 'Creating…' : 'Create asset'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
