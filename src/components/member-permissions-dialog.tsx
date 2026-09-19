'use client';

/**
 * One person's permission overrides.
 *
 * WHAT AN OVERRIDE IS. A role carries a set of permissions;
 * membership_permission adds to it or takes away from it for one person, with
 * a reason and an optional expiry. helm.set_session_context() has honoured
 * that union since the beginning, and until now there was no way to write one
 * except a psql prompt — and, before 0480, no way to REVOKE one at all: the
 * table had no UPDATE or DELETE policy, so both statements affected zero rows
 * and reported success.
 *
 * THREE DISTINCT ACTS, and the interface keeps them distinct because they mean
 * different things to whoever reads the list later:
 *
 *   GRANT   add a permission the role does not carry.
 *   DENY    take away one the role does carry. The row stays, pinned off.
 *   REMOVE  delete the override entirely, so the role decides again.
 *
 * A deny and a removal look the same from outside — the person ends up without
 * the permission — and are opposite intentions. "We deliberately took this away
 * from Sam" is not "Sam's exception expired".
 *
 * WHAT THIS COMPONENT DOES NOT DECIDE. Whether a grant is allowed. Two rules
 * govern that and both live in the database (0480): nobody grants a permission
 * they do not hold, and an MSP-only permission never reaches a client-side
 * role. The picker is filled from the server's `grantable` list, which is
 * derived from those same rules — a convenience so the interface does not offer
 * a choice that comes back as an error, never a second opinion about authority.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Minus, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Modal } from './ui/modal';

interface Override {
  permissionKey: string;
  granted: boolean;
  reason: string;
  expiresAt: string | null;
  grantedBy: string | null;
  category: string;
  description: string;
}

interface Grantable {
  key: string;
  category: string;
  description: string;
}

interface Payload {
  roleKey: string;
  isClientSide: boolean;
  overrides: Override[];
  grantable: Grantable[];
  canManage: boolean;
}

export function MemberPermissionsDialog({
  userId,
  label,
  isSelf,
  open,
  onOpenChange,
}: {
  userId: string;
  label: string;
  /** Nobody edits their own overrides; the route refuses it too. */
  isSelf: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [permissionKey, setPermissionKey] = useState('');
  const [granted, setGranted] = useState(true);
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/users/${userId}/permissions`);
      if (!response.ok) {
        setError(`The permissions could not be loaded (${response.status}).`);
        return;
      }
      setData((await response.json()) as Payload);
    } catch {
      setError('The request did not reach the server.');
    }
  }, [userId]);

  // Loaded when the dialog opens rather than with the page: most rows are never
  // opened, and this is one request per person.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  function reset() {
    setPermissionKey('');
    setGranted(true);
    setReason('');
    setExpiresAt('');
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/users/${userId}/permissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          permissionKey,
          granted,
          reason: reason.trim(),
          ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `The change could not be saved (${response.status}).`);
        return;
      }
      reset();
      await load();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function removeOverride(key: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/users/${userId}/permissions?permission=${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `The override could not be removed (${response.status}).`);
        return;
      }
      await load();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  // Already overridden, so the picker does not offer it twice — re-granting is
  // handled by the route as a correction, but offering it here would read as a
  // second, separate exception.
  const available = (data?.grantable ?? []).filter(
    (p) => !(data?.overrides ?? []).some((o) => o.permissionKey === p.key),
  );
  const canEdit = Boolean(data?.canManage) && !isSelf;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setError(null);
        }
        onOpenChange(next);
      }}
      title={`Permissions for ${label}`}
      icon={KeyRound}
      description="Exceptions to what this person's role carries. Their role decides everything not listed here."
      size="lg"
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-ink">
            {error}
          </p>
        )}

        {!data ? (
          <p className="flex items-center gap-2 text-sm text-ink-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading…
          </p>
        ) : (
          <>
            {data.overrides.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No exceptions. Everything this person can do comes from their role.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {data.overrides.map((o) => (
                  <li key={o.permissionKey} className="flex items-start gap-3 px-3 py-2">
                    <Badge tone={o.granted ? 'ok' : 'danger'}>
                      {o.granted ? 'granted' : 'denied'}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm text-ink">{o.permissionKey}</div>
                      <p className="text-xs text-ink-muted">{o.reason}</p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {o.grantedBy ? `by ${o.grantedBy}` : 'by a removed account'}
                        {o.expiresAt
                          ? ` · until ${new Date(o.expiresAt).toLocaleDateString()}`
                          : ' · no expiry'}
                      </p>
                    </div>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        onClick={() => removeOverride(o.permissionKey)}
                        title="Remove this exception — the role decides again"
                        aria-label={`Remove the ${o.permissionKey} exception`}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {isSelf ? (
              <FieldHint>
                You cannot change your own permissions. Ask another administrator, so a mistake
                here cannot lock the tenant.
              </FieldHint>
            ) : !data.canManage ? (
              <FieldHint>
                Changing permissions needs tenant:write — the same authority as editing the tenant
                itself.
              </FieldHint>
            ) : (
              <form onSubmit={submit} className="space-y-3 border-t border-border pt-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="permission-key">Permission</Label>
                    <Select
                      id="permission-key"
                      value={permissionKey}
                      onChange={(e) => setPermissionKey(e.target.value)}
                      disabled={busy}
                    >
                      <option value="">Choose a permission…</option>
                      {available.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.key} — {p.description}
                        </option>
                      ))}
                    </Select>
                    {data.isClientSide && (
                      <FieldHint>
                        This is a client-side role, so MSP-only permissions are not offered.
                      </FieldHint>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="permission-effect">Effect</Label>
                    <Select
                      id="permission-effect"
                      value={granted ? 'grant' : 'deny'}
                      onChange={(e) => setGranted(e.target.value === 'grant')}
                      disabled={busy}
                    >
                      <option value="grant">Grant — add it to their role</option>
                      <option value="deny">Deny — take it away from their role</option>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="permission-reason">Reason (recorded in the audit log)</Label>
                  <Input
                    id="permission-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why this person, and why now"
                    minLength={10}
                    disabled={busy}
                  />
                  <FieldHint>
                    At least ten characters. An exception outlives everybody&rsquo;s memory of it.
                  </FieldHint>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="permission-expires">Expires (optional)</Label>
                  <Input
                    id="permission-expires"
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    disabled={busy}
                  />
                  <FieldHint>
                    Access for a migration weekend should end with the migration weekend.
                  </FieldHint>
                </div>

                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || !permissionKey || reason.trim().length < 10}
                >
                  {busy ? <Loader2 className="animate-spin" /> : granted ? <Plus /> : <Minus />}
                  {granted ? 'Grant' : 'Deny'}
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
