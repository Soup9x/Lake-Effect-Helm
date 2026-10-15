import Link from 'next/link';
import { Activity, CircleAlert, CircleCheck, Eye } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { formatDate } from '@/lib/ui/format';
import {
  healthSummary, segmentsAccountForAll, type DocumentationHealth,
} from '@/lib/health/window';

/**
 * How much of a client's documentation has gone quiet.
 *
 * A SERVER COMPONENT drawing an inline SVG: no chart library, nothing shipped
 * to the browser, and the whole thing is three arcs and some text.
 *
 * COUNTS, NEVER A SCORE. IT Glue puts a percentage in the middle of this ring
 * and the temptation to copy it is the thing decision 20 exists to resist:
 * Helm can see what has been documented, not what EXISTS, and a blended
 * "68% healthy" is an invented weighting wearing a judgement's clothes. It
 * starts an argument; "11 of 34 records have not been revised since they were
 * created" starts a morning's work. So the middle of the ring holds the number
 * that needs attention, and the legend holds three sentences that are each
 * either true or false.
 *
 * THE SEGMENTS ARE CHECKED BEFORE THEY ARE DRAWN. They come back as three
 * independent SQL FILTER clauses, and "they partition the total" is exactly the
 * kind of property that is true when written and false after an edit. If it
 * ever fails this renders the counts without the ring rather than drawing a
 * circle with a gap in it — a gap in a ring is read as a meaning, and it would
 * not have one.
 *
 * "NOT OPENED" SITS BESIDE THE RING, NOT IN IT, because it answers a different
 * question. Stale means the documentation may be wrong; unopened means nobody
 * needed it — the first is a correction and the second is a retirement, and
 * averaging them into one arc would lose both. It is also the newer number:
 * nothing recorded views before 0680, so a freshly upgraded install shows
 * everything as unopened until people start browsing, which the card says
 * rather than letting somebody read it as neglect.
 */
const SEGMENTS = [
  {
    key: 'current' as const,
    label: 'Revised recently',
    className: 'text-ok',
    stroke: 'var(--color-ok)',
  },
  {
    key: 'stale' as const,
    label: 'Not revised lately',
    className: 'text-sev-warning',
    stroke: 'var(--color-sev-warning)',
  },
  {
    key: 'neverRevised' as const,
    label: 'Never revised',
    className: 'text-sev-critical',
    stroke: 'var(--color-sev-critical)',
  },
];

export function DocumentationHealthCard({
  health,
  organizationId,
  /** False on a fresh upgrade, where nothing has been recorded yet. */
  viewsRecorded,
}: {
  health: DocumentationHealth;
  organizationId: string;
  viewsRecorded: boolean;
}) {
  const needsAttention = health.stale + health.neverRevised;
  const consistent = segmentsAccountForAll(health);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4 text-ink-faint" aria-hidden />
          Documentation health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {health.total === 0 ? (
          <p className="text-ink-muted">
            Nothing is documented for this client yet, so there is nothing to measure.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-5">
              {consistent && (
                <Ring health={health} needsAttention={needsAttention} />
              )}
              <ul className="space-y-1.5">
                {SEGMENTS.map((segment) => {
                  const count = health[segment.key];
                  return (
                    <li key={segment.key} className="flex items-center gap-2">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: segment.stroke }}
                        aria-hidden
                      />
                      {/* A count is somewhere to go, not something to look at.
                          G's lesson: a number nobody can reach behind is a
                          number people stop believing. */}
                      <Link
                        href={`/organizations/${organizationId}?health=${slugFor(segment.key)}`}
                        className="tabular-nums text-ink hover:underline"
                      >
                        {count}
                      </Link>
                      <span className="text-ink-muted">{segment.label}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <p className="flex items-start gap-2 text-ink-muted">
              {needsAttention === 0 ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-sev-warning" aria-hidden />
              )}
              <span>{healthSummary(health)}</span>
            </p>

            {!consistent && (
              /*
               * Shown rather than hidden. The counts came back not adding up,
               * which means one of the view's three predicates has changed and
               * the ring would be misleading. Saying so is the only honest
               * thing on offer; drawing it anyway and hoping nobody measures
               * the arcs is not.
               */
              <p className="rounded-md bg-sev-warning/10 px-2 py-1.5 text-ink">
                These counts do not add up to {health.total}, so the chart is hidden.
                The numbers are shown as they came back.
              </p>
            )}

            <p className="flex items-start gap-2 border-t border-border pt-3 text-ink-muted">
              <Eye className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
              <span>
                {!viewsRecorded ? (
                  <>
                    Nobody has opened anything here since view tracking started, so
                    there is nothing to say about what is still being read.
                  </>
                ) : (
                  <>
                    <Link
                      href={`/organizations/${organizationId}?health=unviewed`}
                      className="font-semibold tabular-nums text-ink hover:underline"
                    >
                      {health.unviewed}
                    </Link>{' '}
                    of {health.total} have not been opened by anyone in{' '}
                    {health.unviewedAfterDays} days
                    {health.lastViewedAt && (
                      <> · last opened {formatDate(health.lastViewedAt)}</>
                    )}
                    . That is a different question from whether they are correct —
                    it says what nobody needs, not what is wrong.
                  </>
                )}
              </span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The URL slug for a segment, which is the view's column name without `_count`. */
function slugFor(key: 'current' | 'stale' | 'neverRevised'): string {
  return key === 'neverRevised' ? 'never_revised' : key;
}

/**
 * Three arcs on one circle.
 *
 * stroke-dasharray on a circle rather than paths with arc commands: the maths
 * is one division instead of trigonometry, and a segment of zero renders as
 * nothing rather than as a sliver.
 *
 * Rotated -90° so the first segment starts at twelve o'clock, which is where a
 * reader expects a ring to start.
 */
function Ring({
  health,
  needsAttention,
}: {
  health: DocumentationHealth;
  needsAttention: number;
}) {
  const RADIUS = 34;
  const circumference = 2 * Math.PI * RADIUS;

  let offset = 0;
  const arcs = SEGMENTS.map((segment) => {
    const count = health[segment.key];
    const length = (count / health.total) * circumference;
    const arc = { key: segment.key, stroke: segment.stroke, length, offset };
    offset += length;
    return arc;
  });

  return (
    <svg
      viewBox="0 0 80 80"
      className="size-20 shrink-0 -rotate-90"
      role="img"
      aria-label={healthSummary(health)}
    >
      {/* The track, so a client whose records are all in one segment still
          reads as a ring rather than as a floating arc. */}
      <circle
        cx="40" cy="40" r={RADIUS} fill="none"
        stroke="var(--color-border)" strokeWidth="8"
      />
      {arcs.map((arc) => (
        arc.length > 0 && (
          <circle
            key={arc.key}
            cx="40" cy="40" r={RADIUS} fill="none"
            stroke={arc.stroke}
            strokeWidth="8"
            strokeDasharray={`${arc.length} ${circumference - arc.length}`}
            strokeDashoffset={-arc.offset}
          />
        )
      ))}
      {/* Counter-rotated so the text is upright inside a rotated svg. */}
      <g className="rotate-90" style={{ transformOrigin: '40px 40px' }}>
        <text
          x="40" y="40"
          textAnchor="middle" dominantBaseline="central"
          className="fill-ink text-base font-semibold tabular-nums"
        >
          {needsAttention}
        </text>
      </g>
    </svg>
  );
}
