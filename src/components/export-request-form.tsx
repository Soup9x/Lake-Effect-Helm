'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FileDown, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { FieldHint, Label, Select, Textarea } from './ui/field';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

const KINDS = [
  ['client_offboarding', 'Client offboarding handover'],
  ['compliance_audit', 'Compliance audit pack'],
  ['disaster_recovery', 'Disaster recovery runbook'],
  ['asset_inventory', 'Asset inventory'],
  ['ad_hoc', 'Ad hoc export'],
] as const;

/**
 * Requesting an export.
 *
 * The form is explicit about the consequence of the credentials checkbox rather
 * than leaving it as an unlabelled toggle, because the difference between the
 * two options is the difference between a document and a copy of the vault.
 *
 * `canExportSecrets` hides the option from someone whose role could never use
 * it. That is a courtesy — helm.request_export() refuses without secret:export
 * regardless — and the point is not to offer a checkbox that always errors.
 */
export function ExportRequestForm({
  organizations,
  canExportSecrets,
  defaultOrganizationId,
}: {
  organizations: { id: string; name: string }[];
  canExportSecrets: boolean;
  defaultOrganizationId?: string | undefined;
}) {
  const [organizationId, setOrganizationId] = useState(
    defaultOrganizationId ?? organizations[0]?.id ?? '',
  );
  const [kind, setKind] = useState<string>('client_offboarding');
  const [reason, setReason] = useState('');
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [ttlHours, setTtlHours] = useState(72);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const response = await fetch('/api/exports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          kind,
          format: 'zip',
          reason: reason.trim(),
          includeSecrets,
          ttlHours,
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'The request was refused.');
        return;
      }

      setReason('');
      setIncludeSecrets(false);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Request an export</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="export-org">Client</Label>
            <Select
              id="export-org"
              value={organizationId}
              onChange={(event) => setOrganizationId(event.target.value)}
              required
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="export-kind">Kind</Label>
            <Select id="export-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
              {KINDS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="export-reason">Reason</Label>
            <Textarea
              id="export-reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why this export is being produced. At least 10 characters."
              required
            />
            <FieldHint>
              Stored on the job and repeated in the audit trail. &ldquo;Why did we export this
              client&rsquo;s vault in March&rdquo; should have an answer.
            </FieldHint>
          </div>

          <div className="space-y-1">
            <Label htmlFor="export-ttl">Available for</Label>
            <Select
              id="export-ttl"
              value={ttlHours}
              onChange={(event) => setTtlHours(Number(event.target.value))}
            >
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </Select>
            <FieldHint>The file is deleted when this elapses.</FieldHint>
          </div>

          {canExportSecrets && (
            <div className="space-y-1">
              <Label htmlFor="export-secrets">Contents</Label>
              <label
                htmlFor="export-secrets"
                className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <input
                  id="export-secrets"
                  type="checkbox"
                  checked={includeSecrets}
                  onChange={(event) => setIncludeSecrets(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-ink">Include credentials</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    Requires a second approver. The bundle is encrypted and every credential in it
                    is decrypted and audited individually.
                  </span>
                </span>
              </label>
            </div>
          )}

          <div className="flex items-end sm:col-span-2">
            <Button
              type="submit"
              variant={includeSecrets ? 'danger' : 'primary'}
              disabled={pending || reason.trim().length < 10 || !organizationId}
            >
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <FileDown aria-hidden />}
              {includeSecrets ? 'Request credential export' : 'Request export'}
            </Button>
          </div>

          {error && (
            <p className="flex items-start gap-1.5 text-xs text-danger sm:col-span-2">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
