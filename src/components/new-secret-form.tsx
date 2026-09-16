'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';

/**
 * Storing a credential.
 *
 * The plaintext lives in this component's state for exactly as long as it takes
 * to submit it, and is cleared in a `finally` — success or failure, including
 * the failure where the request never reached the server. A form that kept the
 * value around so the technician could "try again" would leave a domain admin
 * password in a React tree on an unlocked screen, which is the same exposure
 * the reveal button's auto-hide exists to prevent.
 *
 * For the same reason the field is a password input by default and there is no
 * "show" toggle here: this is the writing end, where the person typing already
 * knows the value and nobody else in the room needs to.
 *
 * `sensitivity` and `requiresReason` are offered at creation rather than left
 * to a later edit, because the moment a credential is stored is the only moment
 * somebody is definitely thinking about what it unlocks.
 */
const KINDS = [
  ['password', 'Password'],
  ['api_key', 'API key'],
  ['ssh_key', 'SSH key'],
  ['private_key', 'Private key'],
  ['certificate', 'Certificate'],
  ['connection_string', 'Connection string'],
  ['totp_seed', 'TOTP seed'],
  ['recovery_code', 'Recovery code'],
  ['license_key', 'Licence key'],
  ['generic', 'Other'],
] as const;

/** Kinds whose value is realistically multi-line. */
const MULTILINE = new Set(['private_key', 'certificate', 'ssh_key']);

export function NewSecretForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('password');
  const [value, setValue] = useState('');
  const [sensitivity, setSensitivity] = useState('standard');
  const [requiresReason, setRequiresReason] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setLabel('');
    setValue('');
    setKind('password');
    setSensitivity('standard');
    setRequiresReason(false);
    setError(null);
    setOpen(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          label: label.trim(),
          kind,
          value,
          sensitivity,
          requiresReason,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(
          payload?.error?.message ?? `The credential could not be stored (${response.status}).`,
        );
        return;
      }

      close();
      router.refresh();
    } catch {
      setError('The request did not reach the server. The credential was not stored.');
    } finally {
      // Unconditional. The plaintext does not survive this handler, whatever
      // happened above — a retry means typing it again, on purpose.
      setValue('');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)} className="gap-2">
        <Plus />
        Store a credential
      </Button>
    );
  }

  return (
    <Card className="mb-4">
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
              <KeyRound className="size-4" />
              Store a credential
            </h2>
            <Button type="button" variant="ghost" size="icon" onClick={close} aria-label="Cancel">
              <X />
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="secret-label">Label</Label>
              <Input
                id="secret-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Domain admin — DC01"
                required
                autoFocus
                maxLength={200}
              />
              <FieldHint>Visible to anyone who can see this client. Not a secret.</FieldHint>
            </div>

            <div>
              <Label htmlFor="secret-kind">Kind</Label>
              <Select id="secret-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                {KINDS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="secret-value">Credential</Label>
            {MULTILINE.has(kind) ? (
              <Textarea
                id="secret-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
                rows={6}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
              />
            ) : (
              <Input
                id="secret-value"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
                spellCheck={false}
                autoComplete="new-password"
              />
            )}
            <FieldHint>
              Encrypted before it is stored, and never shown again without an audited reveal.
            </FieldHint>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="secret-sensitivity">Sensitivity</Label>
              <Select
                id="secret-sensitivity"
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value)}
              >
                <option value="standard">Standard</option>
                <option value="elevated">Elevated</option>
                <option value="critical">Critical</option>
              </Select>
            </div>

            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={requiresReason}
                  onChange={(e) => setRequiresReason(e.target.checked)}
                  className="size-4 rounded border-border-strong"
                />
                Require a reason to reveal
              </label>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" disabled={busy || !label.trim() || !value}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? 'Storing…' : 'Store credential'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
