'use client';

/**
 * Your name, your time zone, and the theme your account defaults to.
 *
 * THE DISPLAY NAME IS DERIVED WHEN THE HALVES ARE SET, and the form shows that
 * rather than offering two independent answers to one question. 0630's trigger
 * composes `name` from the halves on any save that includes them, so a box
 * somebody could type a third answer into would be a box whose contents are
 * sometimes silently discarded. When both halves are empty the box is editable
 * — which is the case for a mononym, and for cleaning up the
 * "SMITH, J (Contractor)" a directory import produces.
 *
 * THE THEME HERE IS THE ACCOUNT DEFAULT, not the same control as the one in the
 * shell. ThemeToggle flips this browser and writes localStorage; it costs no
 * request and cannot fail, and that is worth keeping. This one is what a new
 * machine starts from. Choosing here also applies it locally, because somebody
 * setting their preference means here as well — but it does not write
 * localStorage, so the account value stays authoritative on this browser until
 * the shell toggle is used.
 *
 * ONE FORM, ONE SAVE. Four fields that all live on one row, so four Save
 * buttons would be four requests and four ways to be half-applied.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label, Select } from './ui/field';
import { applyTheme } from './theme-toggle';
import { composedName, THEMES, type AccountPreferences, type Theme } from '@/lib/ui/preferences';
import { cn } from '@/lib/ui/cn';
import { apiFetch } from '@/lib/ui/api';

const THEME_LABELS: Record<Theme, { label: string; icon: typeof Sun }> = {
  system: { label: 'Match the system', icon: Monitor },
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
};

export function ProfileForm({
  preferences,
  /** IANA zone names the server knows, so the picker cannot offer one the database refuses. */
  timezones,
}: {
  preferences: AccountPreferences;
  timezones: string[];
}) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(preferences.firstName ?? '');
  const [lastName, setLastName] = useState(preferences.lastName ?? '');
  const [name, setName] = useState(preferences.name ?? '');
  const [timezone, setTimezone] = useState(preferences.timezone ?? '');
  const [theme, setTheme] = useState<Theme>(preferences.theme);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both empty means the box is the only way to say what you are called.
  const derived = firstName.trim() !== '' || lastName.trim() !== '';
  const willBeCalled = derived
    ? composedName(firstName, lastName, preferences.name)
    : (name.trim() === '' ? null : name.trim());

  const touched = (next: () => void) => () => {
    next();
    setDone(false);
    setError(null);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const result = await apiFetch('/api/account', {
        method: 'PATCH',
        json: {
          // null clears; the route normalises a blank string to null too, so an
          // emptied box never becomes the '' the CHECK refuses.
          firstName: firstName.trim() === '' ? null : firstName.trim(),
          lastName: lastName.trim() === '' ? null : lastName.trim(),
          // Sent only when it is the authority. Sending it alongside the halves
          // would be sending a value the trigger is about to overwrite.
          ...(derived ? {} : { name: name.trim() === '' ? null : name.trim() }),
          timezone: timezone === '' ? null : timezone,
          theme,
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Apply the chosen theme here as well, so the thing just chosen takes
      // effect where it was chosen. Deliberately not written to localStorage —
      // see this file's header and ThemeSync's.
      applyTheme(theme);
      setDone(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-xl space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="first-name">First name</Label>
          <Input
            id="first-name"
            value={firstName}
            onChange={(e) => touched(() => setFirstName(e.target.value))()}
            maxLength={60}
            autoComplete="given-name"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="last-name">Last name</Label>
          <Input
            id="last-name"
            value={lastName}
            onChange={(e) => touched(() => setLastName(e.target.value))()}
            maxLength={60}
            autoComplete="family-name"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="display-name">Display name</Label>
        <Input
          id="display-name"
          value={derived ? (willBeCalled ?? '') : name}
          onChange={(e) => touched(() => setName(e.target.value))()}
          maxLength={120}
          readOnly={derived}
          aria-describedby="display-name-hint"
          placeholder="How your name should appear"
          className={cn(derived && 'cursor-not-allowed text-ink-muted')}
        />
        <FieldHint id="display-name-hint">
          {derived
            ? 'Built from your first and last name. Clear both to write it yourself.'
            : 'Shown beside your actions in the audit log.'}
        </FieldHint>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="timezone">Time zone</Label>
        <Select
          id="timezone"
          value={timezone}
          onChange={(e) => touched(() => setTimezone(e.target.value))()}
          aria-describedby="timezone-hint"
        >
          <option value="">No preference</option>
          {timezones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
        <FieldHint id="timezone-hint">
          Dates and times are shown in UTC with the suffix, so a certificate&rsquo;s expiry means
          one instant to everybody who reads it. Your zone is used where Helm shows your own local
          time beside it.
        </FieldHint>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="theme-default">Default theme</Label>
        <div role="group" aria-labelledby="theme-default" className="flex flex-wrap gap-2">
          {THEMES.map((value) => {
            const { label, icon: Icon } = THEME_LABELS[value];
            return (
              <button
                key={value}
                type="button"
                onClick={touched(() => setTheme(value))}
                aria-pressed={theme === value}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors',
                  theme === value
                    ? 'border-brand bg-brand-tint text-ink'
                    : 'border-border text-ink-muted hover:text-ink',
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
        <FieldHint>
          What a browser you have not used before starts with. The switcher in the shell overrides
          it on this machine only, and keeps doing so until you clear it there.
        </FieldHint>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          Save
        </Button>
        {done && (
          <span className="flex items-center gap-1.5 text-xs text-ok">
            <CheckCircle2 aria-hidden className="size-3.5" />
            Saved.
          </span>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
