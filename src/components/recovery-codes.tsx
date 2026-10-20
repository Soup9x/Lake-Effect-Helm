'use client';

/**
 * Recovery codes, shown once (0960). Each signs in once in place of an
 * authenticator code, for the day the phone is lost; Helm keeps only a hash,
 * so this is the only time anybody sees them.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { copyUnaudited } from '@/lib/ui/clipboard';

export function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    // A browser that refuses the clipboard leaves the codes on screen to copy by hand.
    if ((await copyUnaudited(codes.join('\n'))) !== 'copied') return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Save these somewhere safe — a password manager, not this computer’s desktop. Each one signs
        you in once if you lose your phone. They will not be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-surface-sunken p-3 font-mono text-sm text-ink">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? 'Copied' : 'Copy all'}
      </Button>
    </div>
  );
}
