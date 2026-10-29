import type { ReactNode } from 'react';
import { CalendarClock, CircleAlert, CircleCheck, CircleHelp, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { formatDate, formatDateTime } from '@/lib/ui/format';

/**
 * What the outside world last said, beside what somebody recorded.
 *
 * A SERVER COMPONENT reading nothing and doing nothing, so there is no reason
 * to ship it.
 *
 * THE DISAGREEMENT IS THE POINT. 0670 writes the registry's answer into its own
 * column rather than over the recorded one, precisely so the two can differ in
 * public — "you recorded March, the registry says January" is the most useful
 * sentence this card can produce, and both overwriting and blank-filling would
 * have hidden it. So a difference is called out in its own line, with both
 * dates, and nothing is silently reconciled.
 *
 * "NEVER CHECKED" HAS TWO MEANINGS AND THEY ARE NOT THE SAME. Never checked
 * because nobody turned checking on is a setting; never checked because the
 * registry will not answer is a fault. A card that said only "never" would
 * leave somebody looking for a problem that does not exist, so `enabled` is
 * passed in and the sentence changes.
 *
 * AND THE ALERTS STILL FOLLOW THE RECORDED DATE, which this card says out loud
 * when the two disagree. 0100 projects the recorded column into `expiration`,
 * and 0670 deliberately left that alone rather than silently re-pointing every
 * install's expiry alerts the moment somebody enabled checking — so a reader
 * who sees a disagreement needs to know which of the two the dashboard is
 * counting. Telling them beats being quietly clever.
 */
export interface ExternalCheckState {
  /** Whether this kind of check is switched on for the tenant. */
  enabled: boolean;
  recorded: string | Date | null;
  observed: string | Date | null;
  lastCheckedAt: string | Date | null;
  status: 'ok' | 'failed' | 'unsupported' | null;
  error: string | null;
  /** 'the registry' or 'the server', for a sentence that reads naturally. */
  source: string;
  /** What the recorded field is called on screen, e.g. 'Expires'. */
  recordedLabel: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether two dates disagree by enough to be worth a line.
 *
 * A DAY OF TOLERANCE, because the two are not the same kind of value: a
 * recorded expiry is usually a date somebody typed and the registry's is a
 * timestamp, so "2027-01-01" and "2027-01-01T09:14:32Z" are the same fact and
 * flagging them would make the card cry wolf on every correctly documented
 * domain.
 */
export function datesDisagree(
  recorded: string | Date | null,
  observed: string | Date | null,
): boolean {
  if (recorded === null || observed === null) return false;
  const a = new Date(recorded).getTime();
  const b = new Date(observed).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) > DAY_MS;
}

export function ExternalCheckNote({ state, expiryReviewed = false, children }: {
  state: ExternalCheckState;
  /**
   * Whether the children list the expiry as a field to verify (1140), in which
   * case that row is where a disagreement is shown and acted on, and this
   * card's own warning would say it twice.
   */
  expiryReviewed?: boolean;
  /** Anything else the probe learned, under what this card already says. */
  children?: ReactNode;
}) {
  const disagrees = !expiryReviewed && datesDisagree(state.recorded, state.observed);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4 text-ink-faint" aria-hidden />
          What {state.source} says
          {state.status === 'ok' && <Badge tone="ok">Checked</Badge>}
          {state.status === 'failed' && <Badge tone="warning">Check failed</Badge>}
          {state.status === 'unsupported' && <Badge tone="neutral">Not available</Badge>}
          {state.status === null && <Badge tone="neutral">Never checked</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!state.enabled ? (
          <p className="flex items-start gap-2 text-ink-muted">
            <CircleHelp className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
            <span>
              Automatic checking is off for this tenant, so {state.recordedLabel.toLowerCase()} is
              whatever somebody recorded. An administrator can turn it on under Administration → Integrations.
            </span>
          </p>
        ) : state.status === null ? (
          <p className="flex items-start gap-2 text-ink-muted">
            <Clock className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
            <span>Checking is on; this one has not been looked up yet.</span>
          </p>
        ) : null}

        {state.observed && (
          <p className="flex items-start gap-2">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
            <span className="text-ink">
              {state.source[0]?.toUpperCase()}{state.source.slice(1)} reports{' '}
              <strong className="font-semibold">{formatDate(state.observed)}</strong>
              {state.lastCheckedAt && (
                <span className="text-ink-faint"> · checked {formatDateTime(state.lastCheckedAt)}</span>
              )}
            </span>
          </p>
        )}

        {disagrees && (
          <p className="flex items-start gap-2 rounded-md bg-sev-warning/10 px-2 py-1.5">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-sev-warning" aria-hidden />
            <span className="text-ink">
              This disagrees with the recorded {state.recordedLabel.toLowerCase()} of{' '}
              <strong className="font-semibold">{formatDate(state.recorded)}</strong>. Nothing has
              been changed for you — expiry alerts still follow the recorded date, so correct
              whichever one is wrong.
            </span>
          </p>
        )}

        {(state.status === 'failed' || state.status === 'unsupported') && state.error && (
          <p className="flex items-start gap-2 text-ink-muted">
            <CircleAlert
              className={`mt-0.5 size-4 shrink-0 ${
                state.status === 'failed' ? 'text-sev-warning' : 'text-ink-faint'
              }`}
              aria-hidden
            />
            <span>
              {state.error}
              {state.status === 'unsupported' && (
                <span className="text-ink-faint">
                  {' '}This is not a fault and will not be retried differently.
                </span>
              )}
            </span>
          </p>
        )}
        {children}
      </CardContent>
    </Card>
  );
}
