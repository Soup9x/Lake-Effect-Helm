'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, LayoutDashboard, Plus, X } from 'lucide-react';
import { useDismissable } from '@/lib/ui/use-dismissable';
import { WIDGETS, WIDGET_KEYS, type WidgetKey } from '@/lib/workspace/widgets';
import { Button } from './ui/button';

/**
 * Add, remove and reorder your own dashboard.
 *
 * Buttons rather than drag and drop, and that is a decision rather than a
 * shortcut. Drag needs a pointer, a steady hand and a visible drop target; a
 * pair of arrows works with a keyboard, a screen reader and a trackpad on a
 * laptop balanced on a server rack, which is where this product is used. There
 * are at most five items to order.
 *
 * The layout saves on every change. An explicit Save button is one more thing
 * to forget, and the cost of being wrong here is one click to put a widget
 * back.
 */
export function DashboardCustomise({ layout }: { layout: WidgetKey[] }) {
  const [open, setOpen] = useState(false);
  const [widgets, setWidgets] = useState<WidgetKey[]>(layout);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissable(open, useCallback(() => setOpen(false), []), container, trigger);

  const available = WIDGET_KEYS.filter((key) => !widgets.includes(key));

  async function save(next: WidgetKey[]) {
    const previous = widgets;
    setWidgets(next);
    setFailed(false);
    try {
      const response = await fetch('/api/workspace/dashboard', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ widgets: next }),
      });
      if (!response.ok) {
        setWidgets(previous);
        setFailed(true);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setWidgets(previous);
      setFailed(true);
    }
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= widgets.length) return;
    const next = [...widgets];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    void save(next);
  }

  return (
    <div className="relative" ref={container}>
      <Button
        ref={trigger}
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <LayoutDashboard className="size-4" aria-hidden />
        Customise
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Customise your dashboard"
          className="absolute right-0 z-30 mt-1 w-80 rounded-md border border-border bg-surface-raised p-3 shadow-lg"
        >
          <p className="pb-2 text-xs text-ink-faint">
            Yours alone. Colleagues keep their own arrangement.
          </p>

          <ul className="space-y-1">
            {widgets.map((key, index) => (
              <li
                key={key}
                className="flex items-center gap-1 rounded border border-border px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {WIDGETS[key].title}
                </span>
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink disabled:opacity-30"
                >
                  <ArrowUp className="size-3.5" aria-hidden />
                  <span className="sr-only">Move {WIDGETS[key].title} up</span>
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === widgets.length - 1}
                  className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink disabled:opacity-30"
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                  <span className="sr-only">Move {WIDGETS[key].title} down</span>
                </button>
                <button
                  type="button"
                  onClick={() => void save(widgets.filter((w) => w !== key))}
                  className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-danger"
                >
                  <X className="size-3.5" aria-hidden />
                  <span className="sr-only">Remove {WIDGETS[key].title}</span>
                </button>
              </li>
            ))}
            {widgets.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-ink-faint">
                No widgets. Add one below, or leave it empty.
              </li>
            )}
          </ul>

          {available.length > 0 && (
            <>
              <p className="pb-1 pt-3 text-xs font-medium text-ink-faint">Add</p>
              <ul className="space-y-1">
                {available.map((key) => (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => void save([...widgets, key])}
                      className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-sunken"
                    >
                      <Plus className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
                      <span>
                        <span className="block text-sm text-ink">{WIDGETS[key].title}</span>
                        <span className="block text-xs text-ink-faint">
                          {WIDGETS[key].description}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {failed && (
            <p role="alert" className="pt-2 text-xs text-danger">
              Could not save your layout. Nothing was changed — try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
