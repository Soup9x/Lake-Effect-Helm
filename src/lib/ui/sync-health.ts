/**
 * How a UniFi mapping is doing, in three words plus the two honest
 * non-answers.
 *
 * The settings card already renders per-mapping health, and it answers a
 * narrower question: Paused / Never polled / Polling / Failing. That is right
 * beside a form where the operator is about to change something. A dashboard
 * widget is read at a glance by somebody who is not thinking about UniFi, and
 * the state it has to surface — and the settings card cannot — is STALE: the
 * last poll SUCCEEDED, and it was a long time ago.
 *
 * A stale mapping reports "Polling" in the settings card and looks fine. It is
 * the failure mode that hides: a worker that stopped being scheduled, a
 * container that was never restarted, a controller quietly unreachable in a way
 * that never produced an error row. Nothing is red, and the documentation is
 * drifting.
 *
 * THREE POLL INTERVALS, not one. A poll is due every `pollIntervalSeconds`; one
 * missed cycle is a busy worker or a slow controller and says nothing. Three
 * consecutive misses is a pattern. Below that this reports healthy, because a
 * widget that cries stale on ordinary jitter is a widget people stop reading.
 */
export type SyncState = 'healthy' | 'stale' | 'erroring' | 'paused' | 'never';

export interface SyncMapping {
  isActive: boolean;
  lastPollAt: string | Date | null;
  lastPollOk: boolean | null;
  pollIntervalSeconds: number;
  consecutiveFailures: number;
}

/** How many intervals may pass before a succeeding mapping is called stale. */
export const STALE_AFTER_INTERVALS = 3;

export function syncState(mapping: SyncMapping, now: Date = new Date()): SyncState {
  // Paused is a decision somebody made, not a fault. It outranks staleness:
  // a mapping nobody is polling has not gone stale, it has been switched off.
  if (!mapping.isActive) return 'paused';
  if (mapping.lastPollOk === null || mapping.lastPollAt === null) return 'never';
  if (!mapping.lastPollOk) return 'erroring';

  const last = new Date(mapping.lastPollAt).getTime();
  // An unparseable timestamp is not evidence of health. Reporting stale sends
  // somebody to look; reporting healthy sends nobody.
  if (Number.isNaN(last)) return 'stale';

  // A zero or negative interval would make every mapping stale on arrival.
  const interval = Math.max(mapping.pollIntervalSeconds, 1) * 1000;
  return now.getTime() - last > interval * STALE_AFTER_INTERVALS ? 'stale' : 'healthy';
}

const LABELS: Record<SyncState, string> = {
  healthy: 'Healthy',
  stale: 'Stale',
  erroring: 'Erroring',
  paused: 'Paused',
  never: 'Never polled',
};

export function syncLabel(state: SyncState): string {
  return LABELS[state];
}

/**
 * Deliberately not a colour alone. `paused` and `never` are neutral because
 * neither is a fault; `stale` is a warning rather than a danger because the
 * documentation is old, not wrong.
 */
export function syncTone(state: SyncState): 'ok' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'healthy':
      return 'ok';
    case 'stale':
      return 'warning';
    case 'erroring':
      return 'danger';
    default:
      return 'neutral';
  }
}
