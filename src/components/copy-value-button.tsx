'use client';

/**
 * A small copy button for a value already on screen — a username, an id.
 *
 * `copyUnaudited` rather than reaching for the browser API directly, and that is
 * enforced rather than remembered: tests/unit/clipboard.test.ts scans src/ for
 * any direct write and fails on it. Unaudited is the right half of the door
 * here — the value is already rendered on screen, not secret material, and
 * recording a copy of something anyone with the page open can read would put
 * noise in the trail that matters. A password goes through RevealButton's
 * audited copy instead.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyUnaudited } from '@/lib/ui/clipboard';
import { iconActionClass } from './field-row';

export function CopyValueButton({
  value,
  label,
  size = 'sm',
}: {
  value: string;
  label: string;
  /** `sm` sits inside a list row; `md` matches the other actions on a login row. */
  size?: 'sm' | 'md';
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        const outcome = await copyUnaudited(value);
        if (outcome !== 'copied') return;
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={
        size === 'md'
          ? iconActionClass
          : 'inline-flex size-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink [&_svg]:size-3.5'
      }
    >
      {done ? <Check className="text-ok" aria-hidden /> : <Copy aria-hidden />}
    </button>
  );
}
