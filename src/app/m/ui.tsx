/**
 * Field view's building blocks: big rows, plain lists, nothing that needs a
 * mouse. Server components; the few interactive pieces live in
 * components/field.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/ui/cn';

export function FieldHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-1.5 mt-5 px-1 text-xs font-semibold uppercase tracking-wider text-ink-muted first:mt-1">
      {children}
    </h2>
  );
}

export function FieldList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised">
      {children}
    </ul>
  );
}

export function FieldLinkRow({
  href,
  title,
  subtitle,
  badge,
  lead,
}: {
  href: string;
  title: string;
  subtitle?: string | null | undefined;
  badge?: ReactNode;
  lead?: ReactNode;
}) {
  return (
    <li>
      <Link href={href} className="flex min-h-14 items-center gap-3 px-3.5 py-2.5 active:bg-surface-sunken">
        {lead}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{title}</span>
          {subtitle && <span className="block truncate text-sm text-ink-muted">{subtitle}</span>}
        </span>
        {badge}
        <ChevronRight className="size-4 shrink-0 text-ink-faint" aria-hidden />
      </Link>
    </li>
  );
}

export function FieldEmpty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-ink-muted">{children}</p>;
}

export function Initials({ name }: { name: string }) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-tint text-xs font-semibold text-brand">
      {letters || '?'}
    </span>
  );
}

export function SensitivityBadge({ sensitivity }: { sensitivity: string | null }) {
  if (sensitivity !== 'elevated' && sensitivity !== 'critical') return null;
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        sensitivity === 'critical' ? 'bg-sev-critical/10 text-sev-critical' : 'bg-sev-warning/15 text-sev-warning',
      )}
    >
      {sensitivity}
    </span>
  );
}

export function FieldSearchBox({ defaultValue = '' }: { defaultValue?: string }) {
  return (
    <form action="/m/search" method="get">
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="Search clients, logins, devices…"
        aria-label="Search"
        enterKeyHint="search"
        className="h-12 w-full rounded-xl border border-border bg-surface-raised px-4 text-base text-ink shadow-sm outline-none placeholder:text-ink-faint focus:border-brand"
      />
    </form>
  );
}

/** One labelled value on a detail card, with an optional action at the end. */
export function FieldValue({
  label,
  children,
  action,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink-muted">{label}</div>
        <div className="mt-0.5 break-words text-base text-ink">{children}</div>
      </div>
      {action}
    </div>
  );
}

export function FieldCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised', className)}>
      {children}
    </div>
  );
}
