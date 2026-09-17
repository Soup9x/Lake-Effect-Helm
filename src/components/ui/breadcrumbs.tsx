import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

/**
 * Where you are, and one click back to anywhere above it.
 *
 * A crumb without an href is a place that exists in the hierarchy but has no
 * page of its own — a site, say. It renders as text rather than as a dead link,
 * because a link that does nothing is worse than no link: somebody clicks it,
 * nothing happens, and they conclude the page is broken.
 */
export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The trail holds ANCESTORS ONLY. The page's own name is the <h1> directly
 * below it, and repeating it as the last crumb says the same thing twice in
 * two type sizes.
 *
 * Nothing renders for a top-level page. A one-item breadcrumb reading "Clients"
 * above a heading reading "Clients", beside a nav item reading "Clients", is
 * three copies of one fact.
 */
export function Breadcrumbs({ trail }: { trail: readonly Crumb[] }) {
  if (trail.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="mb-1.5">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
        {trail.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="size-3 text-ink-faint" aria-hidden />}
            {crumb.href ? (
              <Link href={crumb.href} className="rounded hover:text-ink hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span>{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
