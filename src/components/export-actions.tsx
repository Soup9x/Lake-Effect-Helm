'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Loader2, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input, Label } from './ui/field';

/**
 * Revoking and downloading an export.
 *
 * Client components because each one is an audited state change that must be
 * attributable to a click, and because the download is a file transfer the
 * browser has to own.
 *
 * Revoking is a courtesy in the same way every disabled state here is: the
 * database decides, and a client that ignores the UI is still refused.
 *
 * There is no approve button. Two-person approval was removed in 0400 — see
 * db/sql/0400_single_approver_exports.sql for what replaced it.
 */
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
