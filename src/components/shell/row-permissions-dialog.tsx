'use client';

/**
 * Who can see this record, and what it takes to reveal it.
 *
 * NOT AN ACL. Helm has no per-record grant table and this does not invent one —
 * every control below is an existing column with existing enforcement behind it:
 *
 *   Internal only     asset_node.is_internal_only, enforced by the RLS policy
 *                     0390 applies. A client-side role does not see the row at
 *                     all; this is not a hidden flag in the interface.
 *   Sensitivity       secret.sensitivity. 'critical' forces step-up and a
 *                     written reason, which is why ticking it ticks those too.
 *   Re-authentication secret.requires_step_up
 *   Written reason    secret.requires_reason
 *   Minimum role      secret.min_role_rank, checked by helm.reveal_secret
 *
 * RAISING THE FLOOR ABOVE YOUR OWN HEAD IS REFUSED BY THE SERVER, not hidden
 * here: PATCH /api/secrets/:id rejects a minRoleRank above the caller's own
 * rank, so somebody cannot lock themselves — or only themselves — out of a
 * credential. The select below stops at the actor's rank for the same reason a
 * form validates before submitting, not instead of it.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Lock } from 'lucide-react';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { FieldHint, Label, Select } from '../ui/field';

export interface RowPermissions {
  /** asset_node.is_internal_only / attachment.is_internal_only. */
  internalOnly: boolean;
  /** Present only for credential rows. */
  secret?: {
    id: string;
    sensitivity: 'standard' | 'elevated' | 'critical';
    requiresStepUp: boolean;
    requiresReason: boolean;
    minRoleRank: number;
  } | undefined;
}

const RANKS: ReadonlyArray<[number, string]> = [
  [0, 'Anyone who can see the record'],
  [20, 'Client read-only and above'],
  [30, 'Client administrator and above'],
  [40, 'Tier 1 and above'],
  [60, 'Tier 2 and above'],
  [80, 'Tier 3 and above'],
  [100, 'Super administrator only'],
];

export function RowPermissionsDialog({
  rowId,
  rowLabel,
  kind,
  permissions,
  actorRoleRank,
  open,
  onOpenChange,
}: {
  rowId: string;
  rowLabel: string;
  /** Which endpoint owns the visibility flag. */
  kind: 'node' | 'document';
  permissions: RowPermissions;
  /** The signed-in actor's rank; the floor cannot be set above it. */
  actorRoleRank: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [internalOnly, setInternalOnly] = useState(permissions.internalOnly);
  const [sensitivity, setSensitivity] = useState(permissions.secret?.sensitivity ?? 'standard');
  const [stepUp, setStepUp] = useState(permissions.secret?.requiresStepUp ?? false);
  const [reason, setReason] = useState(permissions.secret?.requiresReason ?? false);
  const [minRank, setMinRank] = useState(permissions.secret?.minRoleRank ?? 40);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * 'critical' is not a label, it is a policy: 0040's CHECK refuses a critical
   * secret that does not also require re-authentication and a written reason.
   * Setting it here sets them, so the form cannot submit a combination the
   * database will reject.
   */
  const choose = (next: 'standard' | 'elevated' | 'critical') => {
    setSensitivity(next);
    if (next === 'critical') {
      setStepUp(true);
      setReason(true);
    }
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const calls: Promise<Response>[] = [];

      if (internalOnly !== permissions.internalOnly) {
        calls.push(
          fetch(kind === 'document' ? `/api/documents/${rowId}` : `/api/assets/${rowId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ isInternalOnly: internalOnly }),
          }),
        );
      }

      if (permissions.secret) {
        const s = permissions.secret;
        const changed =
          sensitivity !== s.sensitivity || stepUp !== s.requiresStepUp ||
          reason !== s.requiresReason || minRank !== s.minRoleRank;
        if (changed) {
          calls.push(
            fetch(`/api/secrets/${s.id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                sensitivity, requiresStepUp: stepUp, requiresReason: reason, minRoleRank: minRank,
              }),
            }),
          );
        }
      }

      if (calls.length === 0) {
        onOpenChange(false);
        return;
      }

      const responses = await Promise.all(calls);
      const failed = responses.find((r) => !r.ok);
      if (failed) {
        const body = await failed.json().catch(() => null);
        setError((body as { error?: { message?: string } } | null)?.error?.message
          ?? 'The change could not be saved.');
        return;
      }

      onOpenChange(false);
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Who can see this"
      description={rowLabel}
      icon={Lock}
    >
      <div className="space-y-4">
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={internalOnly}
            onChange={(e) => setInternalOnly(e.target.checked)}
            className="mt-0.5 size-3.5 rounded border-border-strong"
          />
          <span>
            Internal only
            <FieldHint>
              Hidden from the client&rsquo;s own users entirely — not greyed out, not
              listed. Enforced by the database, so it holds on every path including
              search and exports.
            </FieldHint>
          </span>
        </label>

        {permissions.secret && (
          <>
            <div className="border-t border-border pt-4">
              <Label htmlFor="perm-sensitivity">Sensitivity</Label>
              <Select
                id="perm-sensitivity"
                value={sensitivity}
                onChange={(e) => choose(e.target.value as 'standard' | 'elevated' | 'critical')}
              >
                <option value="standard">Standard</option>
                <option value="elevated">Elevated</option>
                <option value="critical">Critical</option>
              </Select>
              <FieldHint>
                Critical requires re-authentication and a written reason, and ticks
                both below — the database refuses the combination without them.
              </FieldHint>
            </div>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox" checked={stepUp} disabled={sensitivity === 'critical'}
                onChange={(e) => setStepUp(e.target.checked)}
                className="size-3.5 rounded border-border-strong"
              />
              Require re-authentication to reveal
            </label>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox" checked={reason} disabled={sensitivity === 'critical'}
                onChange={(e) => setReason(e.target.checked)}
                className="size-3.5 rounded border-border-strong"
              />
              Require a written reason to reveal
            </label>

            <div>
              <Label htmlFor="perm-rank">Minimum role</Label>
              <Select
                id="perm-rank"
                value={String(minRank)}
                onChange={(e) => setMinRank(Number(e.target.value))}
              >
                {RANKS.filter(([rank]) => rank <= actorRoleRank).map(([rank, label]) => (
                  <option key={rank} value={rank}>{label}</option>
                ))}
              </Select>
              <FieldHint>
                Only roles at or above this may reveal the value. The list stops at
                your own role: raising the floor above your own head is refused by
                the server.
              </FieldHint>
            </div>
          </>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
