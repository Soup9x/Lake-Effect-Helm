'use client';

/**
 * Roles: the built-in ladder, and the tenant's own roles built permission by
 * permission (0830).
 *
 * The editor offers only what the database would accept — an access level at
 * or below your own, permissions you hold yourself, nothing MSP-only on a
 * client-side role — and says why the rest is greyed out. The database
 * refuses all of it independently; this is so nobody fills in a form that was
 * never going to save.
 */
import { ChevronDown, ChevronRight, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHint, Input, Label, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { apiFetch } from '@/lib/ui/api';

export interface RoleRow {
  key: string;
  name: string;
  description: string;
  rank: number;
  isTenantWide: boolean;
  isCustom: boolean;
  permissions: string[];
  holders: number;
}

export interface PermissionRow {
  key: string;
  category: string;
  description: string;
  mspOnly: boolean;
}

interface Level {
  rank: number;
  label: string;
  mspStaff: boolean;
}

interface Props {
  roles: RoleRow[];
  permissions: PermissionRow[];
  levels: readonly Level[];
  /** tenant:write — only that defines roles. */
  canManage: boolean;
  myRank: number;
  myPermissions: readonly string[];
}

interface Draft {
  key: string | null;
  name: string;
  description: string;
  mspStaff: boolean;
  rank: number;
  permissions: Set<string>;
}

function levelLabel(levels: readonly Level[], rank: number): string {
  return levels.find((l) => l.rank === rank)?.label ?? `Level ${rank}`;
}

export function RolesManager({ roles, permissions, levels, canManage, myRank, myPermissions }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const held = useMemo(() => new Set(myPermissions), [myPermissions]);
  const byCategory = useMemo(() => {
    const groups = new Map<string, PermissionRow[]>();
    for (const p of permissions) groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
    return [...groups.entries()];
  }, [permissions]);
  const describe = useMemo(() => new Map(permissions.map((p) => [p.key, p])), [permissions]);

  const levelsFor = (mspStaff: boolean) => levels.filter((l) => l.mspStaff === mspStaff && l.rank <= myRank);

  function startNew() {
    const first = levelsFor(true)[levelsFor(true).length - 1] ?? levelsFor(false)[0];
    setDraft({
      key: null, name: '', description: '', mspStaff: first?.mspStaff ?? true,
      rank: first?.rank ?? 40, permissions: new Set(),
    });
    setError(null);
  }

  function startEdit(role: RoleRow) {
    setDraft({
      key: role.key, name: role.name, description: role.description, mspStaff: role.isTenantWide,
      rank: role.rank, permissions: new Set(role.permissions),
    });
    setError(null);
  }

  /** Why a permission cannot be ticked for this draft, or null when it can. */
  function blocked(p: PermissionRow, d: Draft): string | null {
    if (!held.has(p.key)) return 'you do not hold this yourself';
    if (!d.mspStaff && p.mspOnly) return 'MSP staff only';
    return null;
  }

  function copyFrom(key: string) {
    if (!draft) return;
    const source = roles.find((r) => r.key === key);
    if (!source) return;
    const next = new Set(source.permissions.filter((k) => {
      const p = describe.get(k);
      return p ? blocked(p, draft) === null : false;
    }));
    setDraft({ ...draft, permissions: next });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const body = {
      name: draft.name, description: draft.description, rank: draft.rank,
      permissions: [...draft.permissions].sort(),
      ...(draft.key ? {} : { mspStaff: draft.mspStaff }),
    };
    const result = draft.key
      ? await apiFetch(`/api/roles/${draft.key}`, { method: 'PUT', json: body })
      : await apiFetch('/api/roles', { method: 'POST', json: body });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setDraft(null);
    router.refresh();
  }

  async function remove(role: RoleRow) {
    if (!window.confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return;
    const result = await apiFetch(`/api/roles/${role.key}`, { method: 'DELETE' });
    if (!result.ok) {
      window.alert(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-ink-faint" aria-hidden /> Roles
          </CardTitle>
          <p className="mt-1 text-sm text-ink-muted">
            What each role can do. Build your own from individual permissions; the built-in roles stay as they are.
          </p>
        </div>
        {canManage && (
          <Button variant="cta" size="sm" onClick={startNew}>
            <Plus aria-hidden /> New role
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {roles.map((role) => {
            const expanded = open === role.key;
            return (
              <li key={role.key}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : role.key)}
                  >
                    {expanded
                      ? <ChevronDown className="size-4 shrink-0 text-ink-faint" aria-hidden />
                      : <ChevronRight className="size-4 shrink-0 text-ink-faint" aria-hidden />}
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{role.name}</span>
                        <Badge tone={role.isCustom ? 'brand' : 'neutral'}>{role.isCustom ? 'Custom' : 'Built-in'}</Badge>
                        <Badge tone="neutral">{role.isTenantWide ? 'MSP staff' : 'Client'}</Badge>
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        {levelLabel(levels, role.rank)} · {role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'}
                        {' · '}{role.holders} holder{role.holders === 1 ? '' : 's'}
                      </span>
                    </span>
                  </button>
                  {canManage && role.isCustom && (
                    <span className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(role)} aria-label={`Edit ${role.name}`}>
                        <Pencil aria-hidden /> Edit
                      </Button>
                      <Button
                        variant="ghost" size="sm" onClick={() => remove(role)} aria-label={`Delete ${role.name}`}
                        disabled={role.holders > 0}
                        title={role.holders > 0 ? 'Give its holders another role first' : undefined}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </span>
                  )}
                </div>
                {expanded && (
                  <div className="space-y-2 border-t border-border bg-surface-sunken px-4 py-3 text-sm">
                    {role.description && <p className="text-ink-muted">{role.description}</p>}
                    {role.permissions.length === 0
                      ? <p className="text-ink-muted">No permissions.</p>
                      : (
                        <ul className="grid gap-1 sm:grid-cols-2">
                          {role.permissions.map((k) => (
                            <li key={k}>
                              <span className="font-mono text-xs text-ink">{k}</span>
                              {describe.get(k) && <span className="text-xs text-ink-muted"> — {describe.get(k)!.description}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>

      {draft && (
        <Modal
          open
          onOpenChange={(o) => { if (!o) setDraft(null); }}
          title={draft.key ? `Edit ${draft.name || 'role'}` : 'New role'}
          description="A role is an access level and an exact set of permissions. People holding it get the change on their next request."
          icon={ShieldCheck}
          size="lg"
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="role-name">Name</Label>
                <Input id="role-name" value={draft.name} maxLength={60}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="role-kind">Who holds it</Label>
                <Select id="role-kind" value={draft.mspStaff ? 'msp' : 'client'} disabled={draft.key !== null}
                  onChange={(e) => {
                    const mspStaff = e.target.value === 'msp';
                    const level = levelsFor(mspStaff)[levelsFor(mspStaff).length - 1];
                    const kept = new Set([...draft.permissions].filter((k) => mspStaff || !describe.get(k)?.mspOnly));
                    setDraft({ ...draft, mspStaff, rank: level?.rank ?? draft.rank, permissions: kept });
                  }}>
                  <option value="msp">MSP staff — can be given every organisation</option>
                  <option value="client">Client users — pinned to their own organisations</option>
                </Select>
                {draft.key !== null && <FieldHint>Fixed once the role exists.</FieldHint>}
              </div>
            </div>
            <div>
              <Label htmlFor="role-description">Description</Label>
              <Textarea id="role-description" rows={2} value={draft.description} maxLength={400}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="role-level">Access level</Label>
                <Select id="role-level" value={String(draft.rank)}
                  onChange={(e) => setDraft({ ...draft, rank: Number(e.target.value) })}>
                  {levelsFor(draft.mspStaff).map((l) => <option key={l.rank} value={l.rank}>{l.label}</option>)}
                </Select>
                <FieldHint>
                  Which credentials it can see by their minimum level, and which records it can edit. The
                  permissions below decide everything else.
                </FieldHint>
              </div>
              <div>
                <Label htmlFor="role-copy">Start from</Label>
                <Select id="role-copy" value="" onChange={(e) => { if (e.target.value) copyFrom(e.target.value); }}>
                  <option value="">Copy another role's permissions…</option>
                  {roles.filter((r) => r.key !== draft.key).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                </Select>
                <FieldHint>Only the ones this role can hold are copied.</FieldHint>
              </div>
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-ink">
                Permissions <span className="font-normal text-ink-muted">({draft.permissions.size} selected)</span>
              </legend>
              {byCategory.map(([category, perms]) => {
                const selectable = perms.filter((p) => blocked(p, draft) === null);
                const allOn = selectable.length > 0 && selectable.every((p) => draft.permissions.has(p.key));
                return (
                  <div key={category} className="rounded-md border border-border">
                    <div className="flex items-center justify-between border-b border-border bg-surface-sunken px-3 py-1.5">
                      <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{category}</span>
                      {selectable.length > 0 && (
                        <button type="button" className="text-xs text-brand hover:underline"
                          onClick={() => {
                            const next = new Set(draft.permissions);
                            for (const p of selectable) { if (allOn) next.delete(p.key); else next.add(p.key); }
                            setDraft({ ...draft, permissions: next });
                          }}>
                          {allOn ? 'Clear' : 'Select all'}
                        </button>
                      )}
                    </div>
                    <ul className="grid gap-x-4 gap-y-1.5 p-3 sm:grid-cols-2">
                      {perms.map((p) => {
                        const why = blocked(p, draft);
                        const id = `perm-${p.key.replace(':', '-')}`;
                        return (
                          <li key={p.key} className="flex gap-2">
                            <input
                              id={id} type="checkbox" className="mt-0.5"
                              checked={draft.permissions.has(p.key)} disabled={why !== null}
                              onChange={(e) => {
                                const next = new Set(draft.permissions);
                                if (e.target.checked) next.add(p.key); else next.delete(p.key);
                                setDraft({ ...draft, permissions: next });
                              }}
                            />
                            <label htmlFor={id} className={why ? 'text-ink-faint' : undefined}>
                              <span className="font-mono text-xs">{p.key}</span>
                              <span className="block text-xs text-ink-muted">
                                {p.description}{why && <em> — {why}</em>}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </fieldset>

            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={save} disabled={busy || draft.name.trim() === ''}>
                {draft.key ? 'Save role' : 'Create role'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
