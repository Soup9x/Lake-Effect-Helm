'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, Plus } from 'lucide-react';
import { Button } from './ui/button';
import { Modal } from './ui/modal';
import { useStepUp } from './step-up-dialog';
import { toAttemptResult, withStepUp } from '@/lib/ui/step-up';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { parseTagDraft } from '@/lib/ui/tags';

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
 *
 * "CRITICAL" USED TO BE AN OPTION THAT COULD NOT BE CHOSEN, in two independent
 * ways, both measured before they were fixed:
 *
 *   This form never sent `requiresStepUp`, so the CHECK that a critical
 *   credential must require both a step-up and a reason fired on the INSERT,
 *   nothing caught it, and the person got `500 internal error` for ticking a
 *   box this form offered them. Choosing `critical` now turns both on, and
 *   locks them, exactly as the edit form does.
 *
 *   And helm.write_secret_version() refuses to write material for a critical
 *   secret unless the session has stepped up — which nothing in the product
 *   could do, because helm.record_step_up() was never called by anything. So
 *   even a correct payload was refused. The refusal now opens a prompt and
 *   retries the store.
 */
/*
 * THE KIND CATALOGUE IS GONE, along with the MULTILINE set that keyed off it.
 * Both existed to serve a dropdown of ten fixed options that nobody asked for
 * and that does not survive contact with what an MSP stores — "Account type" on
 * a licence key, a username on a certificate. secret.kind still exists and
 * still matters to the reveal and export paths; it simply defaults (0540)
 * instead of being a question.
 */

/*
 * Account type STAYS, unlike Kind, and the difference is worth stating: this
 * describes the ACCOUNT the credential opens, which is documentation somebody
 * reads, whereas Kind described the material, which only the reveal and export
 * paths read. "Other" leads the list because it is now the default — an honest
 * absence rather than a wrong answer nobody typed.
 */
const CREDENTIAL_TYPES = [
  ['other', '—'],
  ['standard_user', 'Standard user'],
  ['local_admin', 'Local admin'],
  ['domain_admin', 'Domain admin'],
  ['service_account', 'Service account'],
  ['api', 'API'],
  ['database', 'Database'],
  ['wifi', 'Wi-Fi'],
  ['vpn', 'VPN'],
  ['root', 'Root'],
  ['recovery', 'Recovery'],
  ['shared_mailbox', 'Shared mailbox'],
] as const;

export function NewSecretForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [sensitivity, setSensitivityState] = useState('standard');
  const [requiresReason, setRequiresReason] = useState(false);
  const [requiresStepUp, setRequiresStepUp] = useState(false);

  /*
   * `critical` is not a label, it is a policy: the schema enforces that a
   * critical credential requires BOTH a step-up and a written reason. Choosing
   * it turns both on rather than letting the save come back refused, and the
   * two lock, because unticking one would make the sensitivity unsaveable for a
   * reason the form had not explained. Same rule, same wording, as the edit
   * form — one policy, stated the same way at both ends.
   */
  const critical = sensitivity === 'critical';
  function setSensitivity(next: string) {
    setSensitivityState(next);
    if (next === 'critical') {
      setRequiresStepUp(true);
      setRequiresReason(true);
    }
  }
  const [tagText, setTagText] = useState('');
  /*
   * 'other', not 'standard_user'. A licence key silently recorded as a standard
   * user account is worse than one recorded as "other" — the first is a wrong
   * answer nobody typed, the second is an honest absence.
   */
  const [credentialType, setCredentialType] = useState('other');
  const [username, setUsername] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setLabel('');
    setValue('');
    setTagText('');
    setSensitivityState('standard');
    setRequiresReason(false);
    setRequiresStepUp(false);
    setCredentialType('other');
    setUsername('');
    setUrl('');
    setNotes('');
    setError(null);
    setOpen(false);
  }

  /**
   * One store attempt.
   *
   * Reads `value` from the render closure rather than a copy taken earlier, so
   * the step-up retry sends the same plaintext without it having to be stashed
   * anywhere new. The `finally` below still clears it once, after both attempts
   * — the retry happens inside the try, which is why it can.
   */
  async function attemptCreate() {
    const response = await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        label: label.trim(),
        value,
        tags: parseTagDraft(tagText),
        sensitivity,
        requiresReason,
        requiresStepUp,
        credentialType,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    });
    const payload = await response.json().catch(() => null);
    return toAttemptResult<unknown>(response.ok, response.status, payload, (b) => b);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      // Storing a `critical` credential needs a stepped-up session. The prompt
      // opens on that refusal and the store is retried, so choosing "Critical"
      // costs a password re-entry rather than being impossible.
      const result = await withStepUp(attemptCreate, stepUp.prompt);

      if (!result.ok) {
        setError(result.message);
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


  return (
    <>
      {stepUp.dialog}
      <Button variant="primary" onClick={() => setOpen(true)} className="gap-2">
        <Plus />
        Store a credential
      </Button>

      <Modal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Every close discards: the X, the backdrop and Escape all land here,
          // and a half-filled form should not survive any of them.
          if (!next) { close() }
        }}
        title="Store a credential"
        icon={KeyRound}
        size="lg"
      >
        <form onSubmit={submit} className="space-y-4">

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
              <Label htmlFor="secret-tags">Tags</Label>
              <Input
                id="secret-tags"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                placeholder="Optional — ssh key, vendor portal"
                maxLength={400}
              />
              <FieldHint>
                Separate with commas. Whatever you would actually search for.
              </FieldHint>
            </div>
          </div>

          <div>
            <Label htmlFor="secret-value">Credential</Label>
            {/*
              MULTILINE USED TO BE CHOSEN BY THE KIND DROPDOWN — a private key
              or a certificate got a textarea, everything else a password box.
              With no kind to read, the trigger is the value itself: a newline
              means multi-line material, and it can only arrive by paste, which
              is how a key gets into this field in the first place.

              This is the one place a shape is inferred, and it infers only how
              to DISPLAY the field. Nothing about what is stored changes.
            */}
            {value.includes('\n') ? (
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

          {/*
            THE ACCOUNT, as opposed to the material above — and all of it
            optional, which is the point of this section rather than an
            oversight.

            The field audit found these three are the ones that do not apply
            universally: "Account type" is meaningless on a licence key, a
            username on a certificate, a URL on an SSH key. With the Kind
            dropdown gone there is no signal left to condition on — tags must
            never be read back to infer what the material is, and the only other
            candidate would be inspecting the plaintext to decide which inputs
            to draw, which couples the form to the secret. So they are marked
            plainly optional rather than conditionally hidden: a heading that
            says so, an "—" option on the one control that had no way to express
            "does not apply", and no required attribute on any of them.
          */}
          <div className="space-y-1 border-t border-border pt-4">
            <p className="text-xs font-medium text-ink-faint">
              About the account — all optional
            </p>
            <FieldHint>
              Leave anything blank that does not apply. A licence key has no username.
            </FieldHint>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="secret-credential-type">Account type</Label>
              <Select
                id="secret-credential-type"
                value={credentialType}
                onChange={(e) => setCredentialType(e.target.value)}
              >
                {CREDENTIAL_TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="secret-username">Username</Label>
              <Input
                id="secret-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Optional"
                maxLength={200}
                autoComplete="off"
              />
            </div>

            <div>
              <Label htmlFor="secret-url">URL</Label>
              <Input
                id="secret-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Optional"
                maxLength={2000}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="secret-notes">Notes</Label>
            <Textarea
              id="secret-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="Optional. Where this is used, what breaks without it."
            />
            <FieldHint>Context, not the credential. Anyone who can see this client reads it.</FieldHint>
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

            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={requiresReason}
                  onChange={(e) => setRequiresReason(e.target.checked)}
                  disabled={critical}
                  className="size-4 rounded border-border-strong disabled:opacity-60"
                />
                Require a reason to reveal
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={requiresStepUp}
                  onChange={(e) => setRequiresStepUp(e.target.checked)}
                  disabled={critical}
                  className="size-4 rounded border-border-strong disabled:opacity-60"
                />
                Require re-authentication to reveal
              </label>
            </div>
          </div>

          {critical && (
            <FieldHint>
              Critical credentials always require both. Storing one asks you to confirm your
              password first.
            </FieldHint>
          )}

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
      </Modal>
    </>
  );
}
