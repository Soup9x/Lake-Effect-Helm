/**
 * A client's logo, or its initials.
 *
 * NOT next/image. The logo is an arbitrary URL a technician pasted — an
 * internal file server, a client's own site, a data URI. next/image wants to
 * proxy and optimise it, which means either a remotePatterns allowlist nobody
 * can maintain for "whatever our clients use" or an optimiser that fetches
 * attacker-chosen URLs from the server. A plain <img> renders it in the
 * browser, where a bad URL costs a broken icon rather than an SSRF.
 *
 * THE FALLBACK IS THE NORMAL CASE, not the error case. Almost no client has a
 * logo on day one, so initials are what this mostly renders and they are
 * styled to look deliberate rather than missing.
 *
 * Server component: it is markup, and keeping it off the client bundle means
 * the clients list can render eighty of them for free.
 */
import { cn } from '@/lib/ui/cn';

/**
 * One or two letters from a name.
 *
 * Takes the first letter of the first two words, so "Acme Manufacturing" is AM
 * and "Globex" is G. Punctuation-only words are skipped — "Northwind
 * (Internal)" is NI, not N(, which is what splitting on whitespace alone
 * gives. Falls back to '?' rather than rendering an empty circle.
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase());
  return letters.join('') || '?';
}

const SIZES = {
  sm: 'size-6 text-[10px]',
  md: 'size-9 text-xs',
  lg: 'size-12 text-sm',
} as const;

export function ClientAvatar({
  name,
  logoUrl,
  size = 'md',
  className,
}: {
  name: string;
  logoUrl?: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string | undefined;
}) {
  const shared = cn(
    'shrink-0 overflow-hidden rounded-md border border-border',
    SIZES[size],
    className,
  );

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        // Empty alt, and deliberately: every call site puts the client's name
        // in adjacent text, so a screen reader announcing it twice is worse
        // than not announcing the image at all.
        alt=""
        aria-hidden
        loading="lazy"
        className={cn(shared, 'bg-surface object-contain')}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        shared,
        'flex items-center justify-center bg-brand-tint font-semibold text-brand-strong',
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
