'use client';

/**
 * The fixed Support button, bottom right.
 *
 * `aria-hidden` is NOT set and it is not decorative: it is the route to a human
 * when something in here refuses to work, which in a credential vault is the
 * most likely moment somebody needs one.
 *
 * It sits above the content at z-40 and carries a shadow rather than a border,
 * so it reads as floating over the grid instead of being part of it. The bright
 * accent green from the brief is used for the ring only — the fill is the
 * accessible CTA green, so the label passes contrast like every other button.
 */
import { LifeBuoy } from 'lucide-react';
import Link from 'next/link';

export function SupportBadge({ href = '/settings' }: { href?: string }) {
  return (
    <Link
      href={href}
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-cta px-4 py-2.5 text-sm font-medium text-on-cta shadow-lg ring-1 ring-cta-accent/40 transition-colors hover:bg-cta-hover"
    >
      <LifeBuoy className="size-4" aria-hidden />
      Support
    </Link>
  );
}
