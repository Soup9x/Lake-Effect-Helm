'use client';

/**
 * Add, remove and reorder the categories in the organization drawer.
 *
 * TWO SCOPES, ONE CONTROL. `scope: 'user'` writes your own layout;
 * `scope: 'tenant'` writes the default a new colleague starts with, and only
 * somebody holding tenant:write ever sees that one. The arrangement being
 * edited is the same shape either way, so two components would be two places to
 * fix the same off-by-one in the reorder.
 *
 * A MODAL, NOT THE DASHBOARD'S POPOVER, and the reason is the drawer. The
 * dashboard's customise control is a popover anchored in a wide, light toolbar.
 * This one opens from a 15rem dark drawer that narrows to 3.5rem when
 * collapsed, where a 20rem panel has nowhere to go. The Modal is centred, is
 * already used by twenty-odd callers, and handles Escape and the backdrop
 * without this file having an opinion about any of it.
 *
 * DRAG TO REORDER, AND THE ARROWS STAY — the same reasoning as the dashboard's,
 * which is worth restating because it is easy to read the arrows as redundant:
 * drag needs a pointer, a steady hand and a visible drop target, while a pair
 * of arrows works with a keyboard, a screen reader, and a trackpad on a laptop
 * balanced on a server rack, which is where this product is used. It is also
 * what the ARIA drag pattern asks for. Both drive reorder(), so they cannot
 * disagree about what a move means.
 *
 * reorder() IS IMPORTED FROM THE DASHBOARD'S MODULE rather than copied. Its own
 * comment names the bug a second copy grows: an arrow that splices before
 * removing, or a drop computing its target against the pre-removal array, moves
 * the item one place too far in one direction only. It is generic list
 * manipulation that happens to live beside the widgets; if a third caller
 * appears it should move somewhere neutral, and until then moving it would be a
 * diff across a feature this change has no other business in.
 *
 * SAVES ON EVERY CHANGE. An explicit Save button is one more thing to forget,
 * and the cost of being wrong is one click to put a category back.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, GripVertical, Plus, RotateCcw, X } from 'lucide-react';
import { Modal } from './ui/modal';
import { Button } from './ui/button';
import { reorder } from '@/lib/workspace/widgets';
import { ORG_CATEGORIES } from '@/lib/nav/org-categories';
import { SIDEBAR_MAX } from '@/lib/nav/sidebar-layout';
import { cn } from '@/lib/ui/cn';
import { apiFetch } from '@/lib/ui/api';

const LABELS = new Map(ORG_CATEGORIES.map((c) => [c.slug, c.label]));
const label = (slug: string): string => LABELS.get(slug) ?? slug;

export type SidebarScope = 'user' | 'tenant';

const COPY: Record<SidebarScope, { title: string; description: string }> = {
  user: {
    title: 'Customise your sidebar',
    description:
      'The categories you choose sit in the drawer, in this order. Everything else stays reachable under “More”. Yours alone — colleagues keep their own arrangement.',
  },
  tenant: {
    title: 'Default sidebar for this tenant',
    description:
      'What somebody sees before they arrange their own. Changing it does not disturb anyone who already has.',
  },
};

export function SidebarCustomise({
  scope,
  layout,
  /** Whether this person has their own row, i.e. whether "follow the default" does anything. */
  customised = false,
  trigger,
}: {
  scope: SidebarScope;
  layout: string[];
  customised?: boolean;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const endpoint = scope === 'user' ? '/api/workspace/sidebar' : '/api/tenant/sidebar-default';

  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<string[]>(layout);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  // The order at pickup, so an abandoned drag puts everything back rather than
  // committing a half-finished rearrangement.
  const [restore, setRestore] = useState<string[] | null>(null);

  const available = ORG_CATEGORIES.filter((c) => !categories.includes(c.slug));

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Re-seeded on BOTH edges: a save calls router.refresh(), which delivers the
    // stored layout as a new prop while this component stays mounted, so state
    // initialised once would drift from what was saved.
    setCategories(layout);
    setFailed(false);
    setDragging(null);
    setRestore(null);
  }

  async function send(method: 'PUT' | 'DELETE', next: string[] | null): Promise<void> {
    const previous = categories;
    if (next) setCategories(next);
    setFailed(false);
    const result = await apiFetch<{ categories?: string[] } | undefined>(endpoint, {
      method,
      ...(next ? { json: { categories: next } } : {}),
    });
    if (!result.ok) {
      setCategories(previous);
      setFailed(true);
      return;
    }
    if (!next) {
      // A reset answers with the layout now in force — the tenant default —
      // which is not something this component could have computed.
      const body = result.value;
      if (Array.isArray(body?.categories)) setCategories(body.categories);
    }
    router.refresh();
  }

  const save = (next: string[]) => void send('PUT', next);

  function move(index: number, delta: number) {
    const next = reorder(categories, index, index + delta);
    // reorder() returns the list unchanged for a move off either end, which is
    // what pressing up on the first item does. Saving that is a request that
    // changes nothing.
    if (next.every((slug, i) => slug === categories[i])) return;
    save(next);
  }

  function onDragOver(overIndex: number) {
    if (!dragging) return;
    const from = categories.indexOf(dragging);
    if (from === -1 || from === overIndex) return;
    // Preview only: the list is reordered in state so what is on screen is the
    // outcome rather than a hint about it. Nothing persists until the drop.
    setCategories(reorder(categories, from, overIndex));
  }

  function onDrop() {
    const before = restore;
    setDragging(null);
    setRestore(null);
    // Unchanged after all the dragging: no request. `before` is the order at
    // pickup, so this also covers a drag that wandered and came back.
    if (!before || before.every((slug, i) => slug === categories[i])) return;
    save(categories);
  }

  function onDragEnd() {
    // Fires after a drop as well as after an abandoned drag. onDrop has cleared
    // `restore` by then, so this only acts on a drag released outside the list
    // or cancelled with Escape.
    if (restore) {
      setCategories(restore);
      setRestore(null);
    }
    setDragging(null);
  }

  return (
    <>
      <span onClick={() => onOpenChange(true)}>{trigger}</span>

      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={COPY[scope].title}
        description={COPY[scope].description}
      >
        <div className="space-y-3">
          <ul className="space-y-1">
            {categories.map((slug, index) => (
              <li
                key={slug}
                draggable
                onDragStart={() => {
                  setRestore(categories);
                  setDragging(slug);
                }}
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
                  dragging === slug && 'border-brand bg-surface-sunken opacity-60',
                )}
              >
                <GripVertical className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{label(slug)}</span>
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink disabled:opacity-30"
                >
                  <ArrowUp className="size-3.5" aria-hidden />
                  <span className="sr-only">Move {label(slug)} up</span>
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === categories.length - 1}
                  className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink disabled:opacity-30"
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                  <span className="sr-only">Move {label(slug)} down</span>
                </button>
                <button
                  type="button"
                  onClick={() => save(categories.filter((s) => s !== slug))}
                  className="rounded p-1 text-ink-faint hover:bg-surface-sunken hover:text-danger"
                >
                  <X className="size-3.5" aria-hidden />
                  <span className="sr-only">Remove {label(slug)} from the sidebar</span>
                </button>
              </li>
            ))}
            {categories.length === 0 && (
              <li className="rounded border border-dashed border-border px-2 py-3 text-sm text-ink-faint">
                Nothing in the drawer. Every category is still under “More”.
              </li>
            )}
          </ul>

          {available.length > 0 && categories.length < SIDEBAR_MAX && (
            <>
              <p className="pt-1 text-xs font-medium text-ink-faint">Under “More”</p>
              <ul className="grid gap-1 sm:grid-cols-2">
                {available.map((category) => (
                  <li key={category.slug}>
                    <button
                      type="button"
                      onClick={() => save([...categories, category.slug])}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-sunken"
                    >
                      <Plus className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                      <span className="truncate text-sm text-ink">{category.label}</span>
                      <span className="sr-only">Add to the sidebar</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {failed && (
            <p role="alert" className="text-sm text-danger">
              Could not save the layout. Nothing was changed — try again.
            </p>
          )}

          {scope === 'user' && customised && (
            <div className="border-t border-border pt-3">
              <Button type="button" variant="ghost" size="sm" onClick={() => void send('DELETE', null)}>
                <RotateCcw className="size-3.5" aria-hidden />
                Follow the tenant default again
              </Button>
              <p className="pt-1 text-xs text-ink-faint">
                Removes your arrangement rather than copying the default into it, so a later change
                by an administrator reaches you.
              </p>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
