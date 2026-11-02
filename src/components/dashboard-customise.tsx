'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDown, ArrowUp, GripVertical, LayoutDashboard, Plus, RectangleHorizontal, RotateCcw, Square,
  Users, X,
} from 'lucide-react';
import { useDismissable } from '@/lib/ui/use-dismissable';
import {
  reorder, WIDGETS, WIDGET_KEYS, type DashboardLayout, type WidgetKey,
} from '@/lib/workspace/widgets';
import { cn } from '@/lib/ui/cn';
import { apiFetch } from '@/lib/ui/api';
import { Button } from './ui/button';

/**
 * Add, remove and reorder your own dashboard.
 *
 * DRAG TO REORDER, AND THE ARROWS STAY. The arrows were here first, with a
 * note explaining that drag needs a pointer, a steady hand and a visible drop
 * target while a pair of arrows works with a keyboard, a screen reader and a
 * trackpad on a laptop balanced on a server rack — which is where this product
 * is used. That reasoning did not stop being true when dragging was added, and
 * it is also the standard way a drag interface is made accessible: the ARIA
 * pattern asks for a keyboard-operable equivalent beside the drag affordance,
 * not instead of it. Both drive reorder(), so they cannot disagree about what
 * a move means.
 *
 * THE DROP PREVIEW IS THE LIST ITSELF. While a drag is in progress the list
 * renders in the order it WOULD have if released now, rather than drawing a
 * separate insertion line: the person sees the outcome instead of a hint about
 * it, and there is no second rendering path to keep in step. Nothing is saved
 * until the drop — an abandoned drag restores the order it started from.
 *
 * NATIVE HTML5 DRAG, no dependency. There are at most eight items in a vertical
 * list inside a popover, which is the one case the native API handles without
 * the workarounds a library exists to provide.
 *
 * The layout saves on every change. An explicit Save button is one more thing
 * to forget, and the cost of being wrong here is one click to put a widget
 * back.
 *
 * WIDTH IS PER WIDGET (1230). Each row has a half/full toggle; a widget's own
 * default (DEFAULT_WIDE) applies until somebody changes one.
 *
 * THE TEAM DEFAULT (1230). Somebody who has never arranged their own sees the
 * layout an administrator set, or Helm's built-in one. Changing anything here
 * makes it theirs; "Reset" puts them back on the team default. An
 * administrator (tenant:write — `teamDefault` is only passed to them) can make
 * their current arrangement the team default, or clear it.
 */
export function DashboardCustomise({
  layout,
  source,
  teamDefault,
}: {
  layout: DashboardLayout;
  source: 'personal' | 'tenant' | 'built_in';
  /** The current team default, for somebody allowed to change it; null otherwise. */
  teamDefault: (DashboardLayout & { set: boolean }) | null;
}) {
  const [open, setOpen] = useState(false);
  const [widgets, setWidgets] = useState<WidgetKey[]>(layout.widgets);
  const [wide, setWide] = useState<WidgetKey[]>(layout.wide);
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissable(open, useCallback(() => setOpen(false), []), container, trigger);

  const available = WIDGET_KEYS.filter((key) => !widgets.includes(key));

  async function save(next: WidgetKey[], nextWide: WidgetKey[] = wide) {
    const previous = { widgets, wide };
    const keptWide = nextWide.filter((key) => next.includes(key));
    setWidgets(next);
    setWide(keptWide);
    setFailed(null);
    setNotice(null);
    const result = await apiFetch('/api/workspace/dashboard', {
      method: 'PUT',
      json: { widgets: next, wide: keptWide },
    });
    if (!result.ok) {
      setWidgets(previous.widgets);
      setWide(previous.wide);
      setFailed('Could not save your layout. Nothing was changed — try again.');
      return;
    }
    startTransition(() => router.refresh());
  }

  function toggleWidth(key: WidgetKey) {
    void save(widgets, wide.includes(key) ? wide.filter((w) => w !== key) : [...wide, key]);
  }

  async function resetToDefault() {
    setFailed(null);
    setNotice(null);
    const result = await apiFetch<DashboardLayout | undefined>('/api/workspace/dashboard', {
      method: 'DELETE',
    });
    if (!result.ok || !result.value) {
      setFailed('Could not reset your dashboard. Nothing was changed — try again.');
      return;
    }
    setWidgets(result.value.widgets);
    setWide(result.value.wide);
    startTransition(() => router.refresh());
  }

  async function setTeamDefault(clear: boolean) {
    setFailed(null);
    setNotice(null);
    const result = await apiFetch('/api/tenant/dashboard-default', clear
      ? { method: 'DELETE' }
      : { method: 'PUT', json: { widgets, wide } });
    if (!result.ok) {
      setFailed('Could not change the team default. Nothing was changed — try again.');
      return;
    }
    setNotice(clear
      ? 'Team default cleared. New colleagues get Helm’s built-in dashboard.'
      : 'Saved. Everybody who has not arranged their own dashboard now sees this one.');
    startTransition(() => router.refresh());
  }

  function move(index: number, delta: number) {
    const next = reorder(widgets, index, index + delta);
    // reorder() returns the list unchanged for a move off either end, which is
    // what pressing up on the first item does. Saving that would be a request
    // that changes nothing.
    if (next.every((key, i) => key === widgets[i])) return;
    void save(next);
  }

  /*
   * Which item is being dragged, and where it currently sits.
   *
   * `dragging` holds the KEY rather than an index, because the index moves
   * underneath it as the preview reorders: the item being dragged is the one
   * the pointer is holding, not the one at a remembered position.
   *
   * `restore` is the order the drag started from, so releasing outside the list
   * — or pressing Escape — puts everything back rather than committing a
   * half-finished rearrangement.
   */
  const [dragging, setDragging] = useState<WidgetKey | null>(null);
  const restore = useRef<WidgetKey[] | null>(null);

  function onDragStart(key: WidgetKey) {
    restore.current = widgets;
    setDragging(key);
  }

  function onDragOver(overIndex: number) {
    if (!dragging) return;
    const from = widgets.indexOf(dragging);
    if (from === -1 || from === overIndex) return;
    // Preview only. The list is reordered in state so what is on screen is the
    // outcome; nothing is persisted until the drop.
    setWidgets(reorder(widgets, from, overIndex));
  }

  function onDrop() {
    const before = restore.current;
    setDragging(null);
    restore.current = null;
    // Unchanged after all the dragging: no request. `before` is the order at
    // pickup, so this also covers a drag that wandered and came back.
    if (!before || before.every((key, i) => key === widgets[i])) return;
    void save(widgets);
  }

  function onDragEnd() {
    // Fires after a drop as well as after an abandoned drag. By then onDrop has
    // cleared `restore`, so this only does something when the drag was
    // abandoned — released outside the list, or cancelled with Escape.
    if (restore.current) {
      setWidgets(restore.current);
      restore.current = null;
    }
    setDragging(null);
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
          className="absolute right-0 z-30 mt-1 max-h-[min(80vh,40rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-md border border-border bg-surface-raised p-3 shadow-lg"
        >
          <p className="pb-2 text-xs text-ink-faint">
            {source === 'personal'
              ? 'Yours alone. Colleagues keep their own arrangement.'
              : source === 'tenant'
                ? 'You are seeing your team’s default. Changing anything makes it yours.'
                : 'Helm’s starting layout. Changing anything makes it yours.'}
          </p>

          <ul className="space-y-1">
            {widgets.map((key, index) => (
              <li
                key={key}
                draggable
                onDragStart={() => onDragStart(key)}
                onDragOver={(event) => {
                  // Without preventDefault the browser refuses the drop and the
                  // cursor shows "no entry" over every target.
                  event.preventDefault();
                  onDragOver(index);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  onDrop();
                }}
                onDragEnd={onDragEnd}
                className={cn(
                  'flex items-center gap-1 rounded border border-border px-2 py-1.5',
                  'cursor-grab active:cursor-grabbing',
                  // The item under the pointer, dimmed so the gap it would
                  // leave is legible while the rest of the list previews the
                  // result around it.
                  dragging === key && 'border-brand bg-surface-sunken opacity-60',
                )}
              >
                <GripVertical
                  className="size-3.5 shrink-0 text-ink-faint"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {WIDGETS[key].title}
                </span>
                <button
                  type="button"
                  onClick={() => toggleWidth(key)}
                  title={wide.includes(key) ? 'Full width — make it half' : 'Half width — make it full'}
                  className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink"
                >
                  {wide.includes(key)
                    ? <RectangleHorizontal className="size-3.5" aria-hidden />
                    : <Square className="size-3.5" aria-hidden />}
                  <span className="sr-only">
                    {WIDGETS[key].title}: {wide.includes(key) ? 'full width' : 'half width'}. Change
                  </span>
                </button>
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

          {(source === 'personal' || teamDefault) && (
            <div className="mt-3 space-y-1 border-t border-border pt-3">
              {source === 'personal' && (
                <button
                  type="button"
                  onClick={() => void resetToDefault()}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-sunken"
                >
                  <RotateCcw className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                  Reset to the team default
                </button>
              )}
              {teamDefault && (
                <>
                  <button
                    type="button"
                    onClick={() => void setTeamDefault(false)}
                    className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-sunken"
                  >
                    <Users className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
                    <span>
                      <span className="block text-sm text-ink">Make this the team default</span>
                      <span className="block text-xs text-ink-faint">
                        What colleagues see until they arrange their own. Nobody’s own layout
                        is changed.
                      </span>
                    </span>
                  </button>
                  {teamDefault.set && (
                    <button
                      type="button"
                      onClick={() => void setTeamDefault(true)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-sunken"
                    >
                      <X className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                      Clear the team default
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {notice && <p role="status" className="pt-2 text-xs text-ok">{notice}</p>}
          {failed && (
            <p role="alert" className="pt-2 text-xs text-danger">{failed}</p>
          )}
        </div>
      )}
    </div>
  );
}
