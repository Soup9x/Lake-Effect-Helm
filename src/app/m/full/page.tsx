import { Monitor } from 'lucide-react';
import { FieldUpgradeForm } from '@/components/field/field-upgrade';

/**
 * Leaving Field view for the full site (1250). The password again, and the
 * authenticator code when there is one: a phone left unlocked can show what
 * it was showing, and cannot be turned into a session that changes things.
 */
export default function FieldFullSite() {
  return (
    <div className="space-y-4 rounded-xl border border-border bg-surface-raised p-4">
      <div className="flex items-center gap-2">
        <Monitor className="size-5 text-brand" aria-hidden />
        <h1 className="text-lg font-semibold tracking-tight text-ink">Open the full site</h1>
      </div>
      <p className="text-sm text-ink-muted">
        Field view is read-only. The full site lets this session make changes, so it asks you to
        confirm it is you first.
      </p>
      <FieldUpgradeForm />
    </div>
  );
}
