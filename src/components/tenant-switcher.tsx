'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/ui/cn';
import { switchTenant } from '@/app/actions';
import type { TenantMembership } from '@/lib/auth/server-identity';

/**
 * The MSP switcher.
 *
 * Note what it switches between: MSP tenants, not client organisations. A
 * technician at one MSP has one tenant and never sees this open; a consultant
 * covering two has two. Client organisations are navigated to within a tenant,
 * because they are data, not an identity boundary — conflating the two is how a
 * UI ends up implying that "switch to Acme" restricts what you can see, when in
 * fact your organisation scope did that when you signed in.
 */
export function TenantSwitcher({
  memberships,
  activeTenantId,
}: {
  memberships: TenantMembership[];
  activeTenantId: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const active = memberships.find((m) => m.tenantId === activeTenantId) ?? memberships[0];

  // One membership is the common case. Rendering a dropdown that can only ever
  // do nothing is noise in a sidebar that is already dense.
  if (memberships.length <= 1) {
    return (
      <div className="flex items-center gap-2 rounded-md px-2 py-2 text-sm">
        <Building2 className="size-4 shrink-0 text-ink-faint" aria-hidden />
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{active?.tenantName}</div>
          <div className="truncate text-xs text-ink-faint">{active?.roleName}</div>
        </div>
      </div>
    );
  }

  const choose = (tenantId: string) => {
    setOpen(false);
    startTransition(async () => {
      await switchTenant(tenantId);
      // Back to the root: a deep link is tenant-specific, and landing on
      // /organizations/<other tenant's id> would render a "not found" that
      // looks like a bug rather than like a successful switch.
      router.push('/dashboard');
      router.refresh();
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border border-border px-2 py-2 text-left text-sm',
          'hover:bg-surface-sunken disabled:opacity-60',
        )}
      >
        <Building2 className="size-4 shrink-0 text-ink-faint" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink">{active?.tenantName}</div>
          <div className="truncate text-xs text-ink-faint">{active?.roleName}</div>
        </div>
        <ChevronsUpDown className="size-4 shrink-0 text-ink-faint" aria-hidden />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg"
        >
          {memberships.map((membership) => (
            <li key={membership.tenantId}>
              <button
                type="button"
                role="option"
                aria-selected={membership.tenantId === activeTenantId}
                onClick={() => choose(membership.tenantId)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-sunken"
              >
                <Check
                  className={cn(
                    'size-4 shrink-0',
                    membership.tenantId === activeTenantId ? 'text-brand' : 'invisible',
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{membership.tenantName}</span>
                  <span className="block truncate text-xs text-ink-faint">
                    {membership.roleName}
                    {membership.orgScopeAll ? '' : ' · limited scope'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
