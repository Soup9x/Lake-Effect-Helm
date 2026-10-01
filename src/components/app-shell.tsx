import type { ReactNode } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Breadcrumbs, type Crumb } from './ui/breadcrumbs';

/*
 * AppShell, its NAV table and HIDDEN_FROM_CLIENTS lived here until the IT
 * Glue-shaped redesign replaced them with src/components/shell/. The chrome is
 * now a dark global bar of four SCOPES plus an organization drawer, so a flat
 * list of eight destinations has nowhere to render.
 *
 * What stayed is everything below: PageHeader, PageBody and EmptyState are used
 * by eleven pages that the redesign does not touch, and moving them would have
 * been churn in files with no other reason to change.
 */

/**
 * Every page's header, and therefore the one place breadcrumbs belong.
 *
 * `trail` is a prop here rather than a component each page remembers to render,
 * because "applied consistently across every nested view" is a property of the
 * shell or it is not a property at all: a breadcrumb that appears on the pages
 * somebody thought of is a navigation aid you cannot rely on, which is worse
 * than none.
 */
export function PageHeader({
  title,
  description,
  trail = [],
  actions,
}: {
  title: string;
  // Explicitly `| undefined`: under exactOptionalPropertyTypes a caller
  // computing a description that may come out empty would otherwise have to
  // build the prop conditionally at every call site.
  description?: string | undefined;
  /** Ancestors only, nearest root first. The page's own name is `title`. */
  trail?: readonly Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface-raised px-6 py-5">
      <div className="min-w-0">
        <Breadcrumbs trail={trail} />
        <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-0.5 max-w-2xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="space-y-6 px-6 py-6">{children}</div>;
}

export function EmptyState({
  icon: Icon = ShieldAlert,
  title,
  description,
  action,
}: {
  icon?: typeof ShieldAlert;
  title: string;
  description?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <Icon className="size-8 text-ink-faint" aria-hidden />
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-md text-sm text-ink-muted">{description}</p>}
      {action}
    </div>
  );
}

export { KeyRound };
