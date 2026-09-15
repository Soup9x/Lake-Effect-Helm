'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, Loader2, ShieldAlert, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';

/**
 * Approving, revoking and downloading an export.
 *
 * Client components because each one is an audited state change that must be
 * attributable to a click, and because the download is a file transfer the
 * browser has to own.
 *
 * The approve button's disabled state is a COURTESY, not a control. The
 * database refuses self-approval, re-approval, approval of a non-queued job and
 * approval by anyone without the permission; this only stops a person from
 * clicking something that is certain to fail.
 */
export function ApproveExportButton({
  exportJobId,
  disabled,
  disabledReason,
}: {
  exportJobId: string;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (disabled) {
    return (
      <span className="text-xs text-ink-faint" title={disabledReason}>
        {disabledReason ?? 'Awaiting another approver'}
      </span>
    );
  }

  const approve = () => {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`/api/exports/${exportJobId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reason.trim().length >= 10 ? { reason: reason.trim() } : {}),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'The approval was refused.');
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      {open ? (
        <div className="space-y-2 rounded-md border border-border bg-surface-sunken p-3">
          <p className="text-xs text-ink-muted">
            You are approving a credential export. Check the client, the scope and the reason
            before confirming — the approval is recorded against your account and is bound to the
            scope as it stands now.
          </p>
          <div className="space-y-1">
            <Label htmlFor={`approve-${exportJobId}`}>Note (optional)</Label>
            <Input
              id={`approve-${exportJobId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What you checked"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={approve} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
              Confirm approval
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          <Check aria-hidden />
          Approve
        </Button>
      )}

      {error && (
        <p className="flex items-start gap-1.5 text-xs text-danger">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}

export function RevokeExportButton({ exportJobId }: { exportJobId: string }) {
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const revoke = () => {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`/api/exports/${exportJobId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'The revocation was refused.');
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <X aria-hidden />
        Revoke
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-danger/30 bg-danger/5 p-3">
      <Label htmlFor={`revoke-${exportJobId}`}>Why is this being revoked?</Label>
      <Input
        id={`revoke-${exportJobId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="At least 10 characters; recorded in the audit log"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          onClick={revoke}
          disabled={pending || reason.trim().length < 10}
        >
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />}
          Revoke export
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * The download.
 *
 * Fetched rather than a plain link so the response headers can be read: the
 * server returns the bundle's SHA-256, which is shown to the person so they can
 * verify the file survived whatever channel they hand it over on. A plain
 * anchor would drop that.
 */
export function DownloadExportButton({
  exportJobId,
  filename,
  encrypted,
}: {
  exportJobId: string;
  filename: string;
  encrypted: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/exports/${exportJobId}/download`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(body.error?.message ?? 'The download was refused.');
        return;
      }

      setDigest(response.headers.get('x-helm-content-sha256'));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('The download failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-1">
      <Button size="sm" variant="secondary" onClick={download} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
        Download
      </Button>
      {encrypted && (
        <p className="text-xs text-ink-faint">
          Encrypted. The passphrase is delivered separately by your administrator.
        </p>
      )}
      {digest && (
        <p className="break-all font-mono text-[11px] text-ink-faint">sha256 {digest}</p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
