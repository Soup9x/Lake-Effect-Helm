'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/ui/cn';

/**
 * Light, dark, or whatever the operating system says.
 *
 * Three states rather than two. A toggle that only flips between light and dark
 * cannot express "follow the system", which is what somebody wants when their
 * machine switches at sunset and they would like Helm to switch with it.
 *
 * The choice is written to the document element as `data-theme`, which is what
 * globals.css keys off, and to localStorage so it survives a reload. It is
 * deliberately NOT stored on the server: it is a per-browser preference, not a
 * fact about the account, and a technician using a bright workshop machine and
 * a dark laptop wants different answers on each. It also means changing it
 * costs no request and cannot fail.
 *
 * `null` renders nothing until mounted. The server does not know what this
 * browser stored, so rendering a guess would light the wrong icon for a frame
 * and then correct itself — and React would complain about the mismatch.
 */
type Choice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'helm.theme';

export function applyTheme(choice: Choice): void {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
}

const OPTIONS: [Choice, string, typeof Sun][] = [
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
  ['system', 'System', Monitor],
];

export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private browsing, or storage blocked. The toggle still works for this
      // page; it just will not be remembered.
    }
    setChoice(stored === 'light' || stored === 'dark' ? stored : 'system');
  }, []);

  function pick(next: Choice) {
    setChoice(next);
    applyTheme(next);
    try {
      if (next === 'system') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // As above: unremembered is better than broken.
    }
  }

  if (choice === null) {
    // Reserve the height so the sidebar does not jump when this appears.
    return <div className="h-8" aria-hidden />;
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-md border border-border bg-surface-sunken p-0.5"
    >
      {OPTIONS.map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          onClick={() => pick(value)}
          aria-pressed={choice === value}
          title={label}
          className={cn(
            'flex flex-1 items-center justify-center rounded px-2 py-1 text-xs transition-colors',
            choice === value
              ? 'bg-surface-raised text-ink shadow-xs'
              : 'text-ink-faint hover:text-ink-muted',
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Applied before first paint, in the document head.
 *
 * Without this the page renders light, then the effect above runs and flips it
 * to dark — a white flash on every navigation for anybody who chose dark, which
 * is exactly the thing dark mode is meant to avoid. It has to be a blocking
 * inline script for the same reason: anything deferred is already too late.
 *
 * Wrapped in try/catch because reading localStorage throws outright in some
 * privacy configurations, and a theme preference must never be the reason a
 * credential vault fails to render.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`;
