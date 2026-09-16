import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/ui/cn';

/**
 * Severity variants mirror the `alert_severity` enum exactly, so a badge cannot
 * drift from what the database computed. `helm.expiration_severity()` is the
 * only thing that decides which one a row gets.
 */
const badge = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-surface-sunken text-ink-muted',
        brand: 'border-transparent bg-brand-tint text-brand-strong',
        ok: 'border-transparent bg-ok/10 text-ok',
        info: 'border-transparent bg-sev-info/10 text-sev-info',
        notice: 'border-transparent bg-sev-notice/10 text-sev-notice',
        warning: 'border-transparent bg-sev-warning/15 text-sev-warning',
        critical: 'border-transparent bg-sev-critical/10 text-sev-critical',
        expired: 'border-sev-expired/30 bg-sev-expired/10 text-sev-expired',
        danger: 'border-transparent bg-danger/10 text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badge>['tone']>;

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/** Map a database severity to its badge tone. Exhaustive by construction. */
export function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case 'expired':
      return 'expired';
    case 'critical':
      return 'critical';
    case 'warning':
      return 'warning';
    case 'notice':
      return 'notice';
    default:
      return 'info';
  }
}
