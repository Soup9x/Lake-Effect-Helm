/**
 * The header above a grid: where you are, what this is, and what you can add.
 *
 * A SERVER COMPONENT. It renders text and links and holds no state, so making it
 * a client component would ship the breadcrumb renderer to the browser for
 * nothing. The `actions` slot takes whatever the page passes — including client
 * components, which compose into a server parent perfectly well.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

export interface Crumb {
  label: string;
  href?: string | undefined;
}

export function ViewHeader({
  trail,
  title,
  description,
  actions,
}: {
  /** Ancestors, nearest root first. The current view is `title`. */
  trail?: readonly Crumb[];
  title: string;
  description?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 px-6 pb-3 pt-5">
      <div className="min-w-0">
        {trail && trail.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1.5 text-xs text-ink-muted">
            {trail.map((crumb, i) => (
              <span key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="text-ink-faint">/</span>}
                {crumb.href ? (
                  <Link href={crumb.href} className="hover:text-ink hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span>{crumb.label}</span>
                )}
              </span>
            ))}
            <span aria-hidden className="text-ink-faint">/</span>
            <span className="text-ink-muted">{title}</span>
          </nav>
        )}
        <h1 className="truncate text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-0.5 max-w-2xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
