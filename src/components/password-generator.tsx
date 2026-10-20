'use client';

/**
 * A password generator, beside every field a new password is typed into.
 *
 * Generated in the browser (src/lib/ui/password-generator.ts) and never sent
 * anywhere on its own: it reaches the server only if somebody presses "Use"
 * and then saves the form it filled, exactly as a typed password would.
 *
 * Two shapes. As a button next to a field it opens a small panel and fills the
 * field; on its own (`standalone`) it is the panel, for a password somebody
 * needs for a system Helm does not hold.
 */
import * as Popover from '@radix-ui/react-popover';
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, RefreshCw, Wand2 } from 'lucide-react';
import { Button } from './ui/button';
import { copyUnaudited } from '@/lib/ui/clipboard';
import {
  DEFAULT_PASSWORD_OPTIONS, MAX_LENGTH, MIN_LENGTH, generatePassword, passwordEntropyBits,
  type PasswordOptions,
} from '@/lib/ui/password-generator';

const TOGGLES: readonly { key: keyof Omit<PasswordOptions, 'length'>; label: string }[] = [
  { key: 'upper', label: 'A–Z' },
  { key: 'lower', label: 'a–z' },
  { key: 'digits', label: '0–9' },
  { key: 'symbols', label: '!#$%' },
  { key: 'avoidAmbiguous', label: 'No look-alikes (0 O 1 l)' },
];

function strength(bits: number): string {
  if (bits >= 100) return 'Very strong';
  if (bits >= 72) return 'Strong';
  if (bits >= 50) return 'Fair';
  return 'Weak';
}

function GeneratorPanel({ onUse }: { onUse?: ((value: string) => void) | undefined }) {
  const [options, setOptions] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [value, setValue] = useState('');
  const [copied, setCopied] = useState(false);

  const regenerate = useCallback((next: PasswordOptions) => setValue(generatePassword(next)), []);
  useEffect(() => { regenerate(options); }, [options, regenerate]);

  const set = <K extends keyof PasswordOptions>(key: K, v: PasswordOptions[K]) =>
    setOptions((o) => ({ ...o, [key]: v }));
  const bits = passwordEntropyBits(options);

  async function copy() {
    if ((await copyUnaudited(value)) !== 'copied') return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-2.5 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-sm text-ink" data-testid="generated-password">{value}</code>
        <button type="button" onClick={() => regenerate(options)} title="Another" aria-label="Generate another"
          className="grid size-7 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink">
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
        <button type="button" onClick={() => void copy()} title="Copy" aria-label="Copy"
          className="grid size-7 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink">
          {copied ? <Check className="size-3.5 text-ok" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        </button>
      </div>

      <label className="block text-xs text-ink-muted">
        <span className="flex justify-between"><span>Length</span><span className="tabular-nums text-ink">{options.length}</span></span>
        <input type="range" min={MIN_LENGTH} max={64} value={options.length}
          onChange={(e) => set('length', Number(e.target.value))} className="mt-1 w-full" aria-label="Length" />
      </label>

      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {TOGGLES.map((t) => (
          <label key={t.key} className="flex items-center gap-1.5 text-xs text-ink">
            <input type="checkbox" checked={options[t.key]} onChange={(e) => set(t.key, e.target.checked)}
              className="size-3.5 rounded border-border-strong" />
            {t.label}
          </label>
        ))}
      </div>

      <p className="text-xs text-ink-faint">
        {strength(bits)} · about {bits} bits. Made in your browser; up to {MAX_LENGTH} characters.
      </p>

      {onUse && (
        <Button type="button" size="sm" variant="primary" className="w-full" onClick={() => onUse(value)}>
          Use this password
        </Button>
      )}
    </div>
  );
}

export function PasswordGenerator({
  onUse,
  standalone = false,
}: {
  onUse?: (value: string) => void;
  standalone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (standalone) return <GeneratorPanel />;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button type="button" variant="secondary" size="sm" className="shrink-0 gap-1.5" title="Generate a password">
          <Wand2 aria-hidden /> Generate
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6}
          className="z-[60] w-80 rounded-md border border-border bg-surface-raised p-3 shadow-lg">
          <GeneratorPanel onUse={onUse ? (v) => { onUse(v); setOpen(false); } : undefined} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
