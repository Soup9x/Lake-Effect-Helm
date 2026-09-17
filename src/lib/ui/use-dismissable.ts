'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Close a popover on an outside click or Escape, and put focus back.
 *
 * Extracted from the account menu so the two popovers in the header behave
 * identically. Two copies of this is how one of them ends up trapping focus, or
 * closing on mousedown while the other closes on click, and nobody notices
 * because each is fine on its own.
 */
export function useDismissable(
  open: boolean,
  close: () => void,
  container: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        trigger.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, container, trigger]);
}
