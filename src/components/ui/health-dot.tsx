import Link from 'next/link';
import { cn } from '@/lib/ui/cn';

/**
 * Red, amber or green for one client.
 *
 * The value comes from v_client_health, which is built on top of
 * v_expiration_dashboard — so the thresholds are helm.expiration_severity()'s
 * and this component decides nothing except what colour to paint. Anything that
 * looked at `expired_count` here and made up its own rule would be a second
 * definition of "critical" that drifts from the one the alert worker acts on.
 *
 * Never colour alone. The dot carries a text label for anybody who cannot
 * distinguish the three, and the reasons are in the title so the answer to
 * "why is this amber" does not require opening the client.
 */
export interface ClientHealth {
  health: string;
  expiredCount: number;
  criticalCount: number;
  warningCount: number;
  reasons: string[] | null;
}

const TONE: Record<string, { dot: string; text: string; label: string }> = {
  red: { dot: 'bg-sev-expired', text: 'text-sev-expired', label: 'At risk' },
  amber: { dot: 'bg-sev-warning', text: 'text-sev-warning', label: 'Watch' },
  green: { dot: 'bg-ok', text: 'text-ok', label: 'Healthy' },
};

/**
 * "2 expired, 1 expiring soon: *.acme.test, acme.test".
 *
 * Both halves are optional, and the SEPARATOR follows from that rather than
 * being assumed. A caller that had the reasons but not the tallies produced
 * ": *.acme.test" — a colon separating nothing from something — which is the
 * kind of sentence that gets read aloud by a screen reader exactly as written.
 * Joining the parts that exist is what makes that unexpressible.
 */
export function healthExplanation(health: ClientHealth): string {
  if (health.health === 'green') return 'Nothing tracked is expiring.';

  const counts = [
    health.expiredCount > 0 ? `${health.expiredCount} expired` : null,
    health.criticalCount > 0 ? `${health.criticalCount} critical` : null,
    health.warningCount > 0 ? `${health.warningCount} expiring soon` : null,
  ].filter(Boolean);

  const parts = [
    counts.length ? counts.join(', ') : null,
    health.reasons?.length ? health.reasons.join(', ') : null,
  ].filter(Boolean);

  // Neither half: the client is not green but nothing was counted or named,
  // which is a state the view should not produce. Say something true rather
  // than an empty string that renders as a bare dot with no label.
  return parts.length ? parts.join(': ') : 'Something tracked needs attention.';
}

export function HealthDot({
  health,
  organizationId,
  showLabel = false,
  className,
}: {
  health: ClientHealth;
  /**
   * When given, the badge links to this client's expirations — the list the
   * colour was computed from. Hover says what is wrong; the click is how
   * somebody gets to the rows and does something about it.
   *
   * Green does not link. There is nothing to show, and a link to an empty list
   * is a promise of information that is not there.
   */
  organizationId?: string;
  showLabel?: boolean;
  className?: string;
}) {
  const tone = TONE[health.health] ?? TONE.green!;
  const explanation = healthExplanation(health);

  const body = (
    <>
      <span className={cn('size-2 shrink-0 rounded-full', tone.dot)} aria-hidden />
      <span className={cn('text-xs font-medium', showLabel ? tone.text : 'sr-only')}>
        {tone.label}
      </span>
      <span className="sr-only">. {explanation}</span>
    </>
  );

  if (organizationId && health.health !== 'green') {
    return (
      <Link
        href={`/expirations?organizationId=${organizationId}`}
        title={explanation}
        className={cn('inline-flex items-center gap-1.5 rounded hover:underline', className)}
      >
        {body}
      </Link>
    );
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} title={explanation}>
      {body}
    </span>
  );
}
