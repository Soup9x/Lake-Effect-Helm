'use client';

/**
 * Starting and editing a network diagram (0880) — one component, because it is
 * one form, as SiteForm is.
 *
 * A new diagram opens on its own page, where the drawing happens; an edit
 * refreshes the page it was made from. The location and network pickers are
 * only labels for finding the diagram later, and say so.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Workflow } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Modal } from './ui/modal';
import { changedFields, hasChanges } from '@/lib/ui/form-diff';
import { apiFetch } from '@/lib/ui/api';

export interface DiagramValues extends Record<string, string | boolean> {
  name: string;
  description: string;
  siteId: string;
  networkId: string;
  isInternalOnly: boolean;
}

const BLANK: DiagramValues = { name: '', description: '', siteId: '', networkId: '', isInternalOnly: false };

export interface DiagramFormProps {
  organizationId: string;
  /** Present means edit. Absent means create. */
  diagram?: { id: string; values: DiagramValues };
  sites: readonly { id: string; name: string }[];
  networks: readonly { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DiagramForm({ organizationId, diagram, sites, networks, open, onOpenChange }: DiagramFormProps) {
  const router = useRouter();
  const editing = diagram !== undefined;
  const initial = diagram?.values ?? BLANK;
  const [values, setValues] = useState<DiagramValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof DiagramValues>(key: K, value: DiagramValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setValues(initial);
      setError(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = editing
        ? changedFields(initial, values)
        : {
            organizationId,
            name: values.name.trim(),
            isInternalOnly: values.isInternalOnly,
            ...(values.description.trim() ? { description: values.description.trim() } : {}),
            ...(values.siteId ? { siteId: values.siteId } : {}),
            ...(values.networkId ? { networkId: values.networkId } : {}),
          };
      const result = await apiFetch<{ diagram?: { id: string } }>(
        editing ? `/api/diagrams/${diagram.id}` : '/api/diagrams',
        { method: editing ? 'PATCH' : 'POST', json: payload },
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onOpenChange(false);
      if (!editing && result.value?.diagram) router.push(`/diagrams/${result.value.diagram.id}`);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const dirty = editing ? hasChanges(initial, values) : values.name.trim().length > 0;

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title={editing ? `Edit ${initial.name}` : 'New diagram'}
      icon={Workflow}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="diagram-name">Name</Label>
          <Input id="diagram-name" value={values.name} onChange={(e) => set('name', e.target.value)}
            placeholder="Head office LAN" required autoFocus maxLength={200} />
        </div>
        <div>
          <Label htmlFor="diagram-description">Description</Label>
          <Textarea id="diagram-description" value={values.description} rows={2} maxLength={4000}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Optional. What this drawing shows, and what it leaves out." />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="diagram-site">Location</Label>
            <Select id="diagram-site" value={values.siteId} onChange={(e) => set('siteId', e.target.value)}>
              <option value="">No particular location</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <FieldHint>Lets “Add this location’s configurations” fill the drawing.</FieldHint>
          </div>
          <div>
            <Label htmlFor="diagram-network">Network</Label>
            <Select id="diagram-network" value={values.networkId} onChange={(e) => set('networkId', e.target.value)}>
              <option value="">Not about one network</option>
              {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </Select>
            <FieldHint>Shown on that network’s page.</FieldHint>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={values.isInternalOnly}
            onChange={(e) => set('isInternalOnly', e.target.checked)}
            className="size-4 rounded border-border-strong"
          />
          Internal only — hidden from the client’s own users
        </label>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy && <Loader2 className="animate-spin" />}
            {editing ? 'Save changes' : 'Create and open'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
