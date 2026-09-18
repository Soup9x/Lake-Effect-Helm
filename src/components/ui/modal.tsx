'use client';

/**
 * The dialog every add and edit flow opens in.
 *
 * WHY THIS EXISTS. Every form in the product used to render inline — a Card
 * that appeared between the "Add" button and the list below it, pushing the
 * page down and reflowing everything the person was looking at. Filling one in
 * meant losing your place in the list you were adding to.
 *
 * WHY RADIX RATHER THAN A DIV WITH A FIXED POSITION. @radix-ui/react-dialog was
 * already a dependency and entirely unused. It brings the parts of a dialog
 * that are tedious to get right and invisible when they are wrong: the content
 * is portalled to the end of the body so it cannot be clipped by an ancestor's
 * overflow or stacking context, focus moves into the panel and is trapped there
 * while it is open, focus returns to whatever opened it on close, the rest of
 * the page is marked aria-hidden, Escape closes, and the background stops
 * scrolling underneath. Hand-rolling that is how a modal ends up unusable with
 * a keyboard.
 *
 * All three closes the brief asked for come from that: the X button, a click on
 * the backdrop, and Escape. None of them submit, so an abandoned form is
 * discarded exactly as an abandoned form should be — the state lives in the
 * caller and is reset by `onOpenChange(false)`.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/ui/cn';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Sits under the title. One sentence, for anything the form cannot say itself. */
  description?: string;
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
  /** Wider, for forms with two columns of real content. */
  size?: 'md' | 'lg';
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  icon: Icon,
  children,
  size = 'md',
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/*
          The backdrop is a real element rather than a shadow on the panel, so
          a click anywhere outside closes and the page behind is visibly
          inert rather than merely covered.
        */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'max-h-[calc(100vh-4rem)] overflow-y-auto rounded-lg border border-border-strong',
            'bg-surface-raised p-5 shadow-xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            size === 'lg' ? 'max-w-3xl' : 'max-w-xl',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="flex items-center gap-2 text-sm font-medium text-ink">
                {Icon && <Icon className="size-4 text-ink-faint" />}
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-xs text-ink-muted">
                  {description}
                </Dialog.Description>
              ) : (
                // Radix warns when a dialog has no description. Saying "there
                // isn't one" explicitly is better than a decorative sentence
                // that a screen reader then has to read out every time.
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
