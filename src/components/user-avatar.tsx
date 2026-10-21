/**
 * A person's profile picture (1040), or their initials.
 *
 * The client logo's sibling (client-avatar.tsx), round rather than square so a
 * person and a client never look like the same kind of thing beside each other.
 * Initials are the normal case, styled to look deliberate rather than missing.
 *
 * No 'use client' — it is markup, and the account menu, a client component,
 * renders it as happily as a server page does.
 */
import { cn } from '@/lib/ui/cn';
import { initials } from '@/lib/ui/format';

const SIZES = {
  xs: 'size-6 text-[10px]',
  sm: 'size-7 text-xs',
  md: 'size-9 text-xs',
  lg: 'size-16 text-lg',
} as const;

export function UserAvatar({
  name,
  src,
  size = 'md',
  className,
}: {
  name: string;
  src?: string | null | undefined;
  size?: keyof typeof SIZES;
  /** Colours for the initials; the shell's dark bar passes its own. */
  className?: string | undefined;
}) {
  const shared = cn('shrink-0 overflow-hidden rounded-full', SIZES[size]);
  if (src) {
    // Empty alt: every call site shows the name beside it.
    return <img src={src} alt="" aria-hidden className={cn(shared, 'bg-surface object-cover')} />;
  }
  return (
    <span
      aria-hidden
      className={cn(shared, 'grid place-items-center bg-brand-tint font-medium text-brand-strong', className)}
    >
      {initials(name)}
    </span>
  );
}
