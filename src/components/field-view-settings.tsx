'use client';

/**
 * Administration → Mobile access (1250): how Field view, the read-only phone
 * view, behaves for everybody in this MSP.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Smartphone } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';
import { apiFetch } from '@/lib/ui/api';
import { formatDateTime } from '@/lib/ui/format';
import {
  FIELD_SECTION_LABELS, FIELD_SECTIONS, type FieldSection, type FieldViewPolicy,
} from '@/lib/field/sections';

export function FieldViewSettingsCard({ initial }: { initial: FieldViewPolicy }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [idle, setIdle] = useState(String(initial.idleMinutes));
  const [absolute, setAbsolute] = useState(String(initial.absoluteHours));
  const [critical, setCritical] = useState(initial.criticalOnPhone);
  const [sections, setSections] = useState<FieldSection[]>(initial.sections);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty =
    enabled !== saved.enabled ||
    idle !== String(saved.idleMinutes) ||
    absolute !== String(saved.absoluteHours) ||
    critical !== saved.criticalOnPhone ||
    sections.join() !== saved.sections.join();

  const toggle = (section: FieldSection, on: boolean) =>
    setSections((current) => FIELD_SECTIONS.filter((s) => (s === section ? on : current.includes(s))));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ policy: FieldViewPolicy }>('/api/tenant/field-view', {
        method: 'PUT',
        json: {
          enabled,
          idleMinutes: Number(idle),
          absoluteHours: Number(absolute),
          criticalOnPhone: critical,
          sections,
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const policy = result.value.policy;
      setSaved(policy);
      setEnabled(policy.enabled);
      setIdle(String(policy.idleMinutes));
      setAbsolute(String(policy.absoluteHours));
      setCritical(policy.criticalOnPhone);
      setSections(policy.sections);
      setNotice('Saved. Phone sessions pick it up from their next request.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4 text-ink-faint" aria-hidden /> Field view
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-5">
          <p className="text-sm text-ink-muted">
            Signing in on a phone offers Field view: search, a client’s logins, devices, contacts and
            locations, and passwords shown large for typing on a client’s machine. It is read-only on the
            server, not just on screen. Opening the full site from a phone asks for the password again,
            and every password shown or copied there is marked as from Field view in the audit log.
          </p>

          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 size-4 rounded border-border-strong" />
            <span>
              Offer Field view on phones
              <span className="block text-xs text-ink-muted">
                Off: phones sign in to the full site, which fits a phone screen too.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="fv-idle">Phone idle timeout (minutes)</Label>
              <Input id="fv-idle" type="number" inputMode="numeric" min={2} max={240} required
                value={idle} onChange={(e) => setIdle(e.target.value)} />
              <FieldHint>A phone session left alone this long is signed out. 2 to 240.</FieldHint>
            </div>
            <div>
              <Label htmlFor="fv-absolute">Phone sign-in lasts (hours)</Label>
              <Input id="fv-absolute" type="number" inputMode="numeric" min={1} max={72} required
                value={absolute} onChange={(e) => setAbsolute(e.target.value)} />
              <FieldHint>However active. 1 to 72. The stricter of this and the session limits wins.</FieldHint>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Critical credentials on a phone</legend>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="radio" name="fv-critical" checked={critical === 'step_up'}
                onChange={() => setCritical('step_up')} className="mt-0.5" />
              <span>
                Allow, with the usual password re-entry and written reason
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="radio" name="fv-critical" checked={critical === 'block'}
                onChange={() => setCritical('block')} className="mt-0.5" />
              <span>
                Never show them in Field view
                <span className="block text-xs text-ink-muted">
                  Refused by the server, not just hidden. They stay available on a computer.
                </span>
              </span>
            </label>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Sections shown</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {FIELD_SECTIONS.map((section) => (
                <label key={section} className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={sections.includes(section)}
                    onChange={(e) => toggle(section, e.target.checked)}
                    className="size-4 rounded border-border-strong" />
                  {FIELD_SECTION_LABELS[section]}
                </label>
              ))}
            </div>
            <FieldHint>Search always works and finds anything you can see.</FieldHint>
          </fieldset>

          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {notice && <p className="text-sm text-ok">{notice}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" size="sm" disabled={busy || !dirty}>Save</Button>
            {saved.updatedAt && (
              <span className="text-xs text-ink-faint">Last changed {formatDateTime(new Date(saved.updatedAt))}</span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
