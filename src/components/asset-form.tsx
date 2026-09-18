'use client';

/**
 * Editing an asset.
 *
 * SEPARATE FROM THE ADD FORM, unlike sites, and the reason is the data model
 * rather than convenience. Creating an asset is mostly about choosing its KIND
 * and the one subtype field that kind cannot exist without — a device's type,
 * an IP's address. None of that is editable afterwards: `node_type` is half the
 * composite key the subtype row hangs off, so changing it would orphan that row
 * rather than convert it. Editing is about the node's own columns, which the
 * add form does not ask for at all.
 *
 * Two forms with almost no overlapping fields, sharing the same modal. Merging
 * them would mean one component whose every field is conditional on a mode.
 *
 * This replaces RenameAsset, which offered only the name while
 * PATCH /api/assets/[nodeId] had accepted eight fields since the day it was
 * written.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Server } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { changedFields, hasChanges, type FieldValue } from '@/lib/ui/form-diff';

const STATUSES = ['active', 'inactive', 'retired', 'planned', 'maintenance'] as const;

export interface AssetValues extends Record<string, FieldValue> {
  name: string;
  description: string;
  status: string;
  criticality: number;
  siteId: string;
  isInternalOnly: boolean;
  tags: string[];
}

export function AssetForm({
  nodeId,
  values: initial,
  sites,
  canEdit,
}: {
  nodeId: string;
  values: AssetValues;
  sites: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<AssetValues>(initial);
  const [tagText, setTagText] = useState(initial.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof AssetValues>(key: K, value: AssetValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setValues(initial);
      setTagText(initial.tags.join(', '));
      setError(null);
    }
  }

  function applyTags(text: string) {
    setTagText(text);
    set(
      'tags',
      text
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const changes = changedFields(initial, values);
      // siteId is the one field whose "cleared" value is meaningful: an empty
      // select means "not at any site", which the API takes as an explicit
      // null rather than as an absent key.
      const payload: Record<string, unknown> = { ...changes };
      if ('siteId' in changes) payload.siteId = values.siteId === '' ? null : values.siteId;

      const response = await fetch(`/api/assets/${nodeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `The changes could not be saved (${response.status}).`);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) return null;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <Pencil />
        Edit
      </Button>

      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={`Edit ${initial.name}`}
        icon={Server}
        description="The kind of asset cannot be changed — documenting the same thing as a different kind is a new asset and a link between them."
      >
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="asset-name">Name</Label>
            <Input
              id="asset-name"
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              required
              autoFocus
              maxLength={200}
            />
            <FieldHint>Links, credentials and history stay attached.</FieldHint>
          </div>

          <div>
            <Label htmlFor="asset-description">Description</Label>
            <Textarea
              id="asset-description"
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="asset-status">Status</Label>
              <Select
                id="asset-status"
                value={values.status}
                onChange={(e) => set('status', e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/^./, (c) => c.toUpperCase())}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="asset-criticality">Criticality</Label>
              <Select
                id="asset-criticality"
                value={String(values.criticality)}
                onChange={(e) => set('criticality', Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <FieldHint>5 is “the business stops”.</FieldHint>
            </div>
            <div>
              <Label htmlFor="asset-site">Site</Label>
              <Select
                id="asset-site"
                value={values.siteId}
                onChange={(e) => set('siteId', e.target.value)}
              >
                <option value="">No site</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="asset-tags">Tags</Label>
            <Input
              id="asset-tags"
              value={tagText}
              onChange={(e) => applyTags(e.target.value)}
              placeholder="comma, separated"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={values.isInternalOnly}
                onChange={(e) => set('isInternalOnly', e.target.checked)}
                className="size-4 rounded border-border-strong"
              />
              Internal only
            </label>
            <FieldHint className="mt-1">
              Hidden from the client&rsquo;s own users, and excluded from anything they can export.
            </FieldHint>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !hasChanges(initial, values) || !values.name.trim()}
            >
              {busy && <Loader2 className="animate-spin" />}
              Save changes
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
