'use client';

/**
 * Turning outbound domain and certificate checking on, and saying what that
 * means before somebody does.
 *
 * THE CONSEQUENCE IS ON THE SCREEN, NOT IN A DOC. Enabling the domain check
 * sends every client's domain names to whoever answers the RDAP endpoint, and
 * enabling the certificate check opens a TLS connection to each certificate's
 * common name. Both are reasonable things for an MSP tool to do and neither is
 * obvious from a toggle labelled "enabled", so each says what leaves the
 * building and the endpoint is an editable field rather than a constant.
 *
 * OFF IS A COMPLETE STATE. Decision 4: an air-gapped install must keep working
 * with zero configuration. So there is no nagging, no "recommended" badge and
 * no empty-state prompting somebody to enable it — the form opens on whatever
 * is stored, and "nothing is enabled" is a finished answer rather than a
 * half-configured one.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Input, Label } from './ui/field';
import { Modal } from './ui/modal';
import {
  INTERVAL_MAX_HOURS, INTERVAL_MIN_HOURS, type ExternalCheckSetting,
} from '@/lib/external/settings';
import { apiFetch } from '@/lib/ui/api';

export function ExternalChecksForm({
  setting,
  trigger,
}: {
  setting: ExternalCheckSetting;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [domains, setDomains] = useState(setting.domainsEnabled);
  const [certificates, setCertificates] = useState(setting.certificatesEnabled);
  const [hours, setHours] = useState(String(setting.intervalHours));
  const [endpoint, setEndpoint] = useState(setting.rdapBaseUrl);

  /*
   * Re-seeded on OPEN rather than on close.
   *
   * C2 shipped the other way round and it was wrong: after a successful save,
   * router.refresh() delivers the new values as props while the draft still
   * holds the pre-edit ones, so reopening offers to put them back. Seeding when
   * the dialog opens means the draft is always what is stored.
   */
  function openWith(next: boolean) {
    if (next) {
      setDomains(setting.domainsEnabled);
      setCertificates(setting.certificatesEnabled);
      setHours(String(setting.intervalHours));
      setEndpoint(setting.rdapBaseUrl);
      setError(null);
    }
    setOpen(next);
  }

  async function save() {
    const parsed = Number.parseInt(hours, 10);
    if (!Number.isFinite(parsed) || parsed < INTERVAL_MIN_HOURS || parsed > INTERVAL_MAX_HOURS) {
      setError(`The interval must be between ${INTERVAL_MIN_HOURS} and ${INTERVAL_MAX_HOURS} hours.`);
      return;
    }
    if (!endpoint.startsWith('https://')) {
      setError('The RDAP endpoint must be an https:// URL.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/tenant/external-checks', {
        method: 'PUT',
        json: {
          domainsEnabled: domains,
          certificatesEnabled: certificates,
          intervalHours: parsed,
          rdapBaseUrl: endpoint.trim(),
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span onClick={() => openWith(true)}>{trigger}</span>
      <Modal
        open={open}
        onOpenChange={openWith}
        title="Domain and certificate checking"
        description="Helm can refresh what the outside world says about a domain's registration and a certificate's validity. Both are off until you turn them on."
      >
        <div className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={domains}
              onChange={(e) => setDomains(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-ink">Check domain registrations</span>
              <FieldHint>
                Looks each domain up over RDAP and records the registry&rsquo;s expiry beside the
                one you recorded. <strong>Your clients&rsquo; domain names are sent to the
                endpoint below.</strong>
              </FieldHint>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={certificates}
              onChange={(e) => setCertificates(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-ink">Check certificates</span>
              <FieldHint>
                Opens a TLS connection to each certificate&rsquo;s common name and records what is
                actually being served. Nothing is sent on the connection. A certificate on a host
                this server cannot reach — an internal one, usually — will record a failure and
                keep whatever you entered by hand.
              </FieldHint>
            </span>
          </label>

          <div>
            <Label htmlFor="check-interval">Re-check every</Label>
            <div className="flex items-center gap-2">
              <Input
                id="check-interval"
                type="number"
                min={INTERVAL_MIN_HOURS}
                max={INTERVAL_MAX_HOURS}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="w-28"
              />
              <span className="text-sm text-ink-muted">hours</span>
            </div>
            <FieldHint>
              A registration moves once a year and a certificate once a quarter, so a tighter
              interval is load on somebody else&rsquo;s registry for no new information.
            </FieldHint>
          </div>

          <div>
            <Label htmlFor="check-endpoint">RDAP endpoint</Label>
            <Input
              id="check-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://rdap.org"
            />
            <FieldHint>
              Where domain lookups are sent. The default is a community redirector that forwards
              to each registry; point it at a registrar&rsquo;s own RDAP service or an internal
              mirror if you would rather not involve it. https only.
            </FieldHint>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Save
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
