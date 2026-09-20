/**
 * The state a dashboard widget reports for a UniFi mapping.
 *
 * `stale` is the reason this exists and the reason it is tested: the settings
 * card reports a mapping whose last poll succeeded as "Polling", however long
 * ago that was. A worker that stopped being scheduled looks perfectly healthy
 * there.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STALE_AFTER_INTERVALS, syncState, syncTone, type SyncMapping } from '../../src/lib/ui/sync-health';

const NOW = new Date('2026-09-20T12:00:00Z');
const agoSeconds = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

const mapping = (over: Partial<SyncMapping> = {}): SyncMapping => ({
  isActive: true,
  lastPollAt: agoSeconds(60),
  lastPollOk: true,
  pollIntervalSeconds: 900,
  consecutiveFailures: 0,
  ...over,
});

describe('syncState', () => {
  it('is healthy when the last poll succeeded recently', () => {
    expect(syncState(mapping(), NOW)).toBe('healthy');
  });

  it('is erroring when the last poll failed', () => {
    expect(syncState(mapping({ lastPollOk: false }), NOW)).toBe('erroring');
  });

  it('is STALE when the last poll succeeded but long ago', () => {
    // The case the settings card calls "Polling". 900s interval, last heard
    // from an hour ago: four intervals, nothing red, documentation drifting.
    expect(syncState(mapping({ lastPollAt: agoSeconds(3600) }), NOW)).toBe('stale');
  });

  it('tolerates ordinary jitter rather than crying stale', () => {
    // One missed cycle is a busy worker. A widget that flags that is a widget
    // people stop reading.
    expect(syncState(mapping({ lastPollAt: agoSeconds(900 * 1.5) }), NOW)).toBe('healthy');
    expect(syncState(mapping({ lastPollAt: agoSeconds(900 * 2.9) }), NOW)).toBe('healthy');
  });

  it('draws the line at the documented number of intervals', () => {
    const interval = 600;
    const justInside = agoSeconds(interval * STALE_AFTER_INTERVALS - 1);
    const justOutside = agoSeconds(interval * STALE_AFTER_INTERVALS + 1);
    expect(syncState(mapping({ pollIntervalSeconds: interval, lastPollAt: justInside }), NOW)).toBe('healthy');
    expect(syncState(mapping({ pollIntervalSeconds: interval, lastPollAt: justOutside }), NOW)).toBe('stale');
  });

  it('respects a short interval: stale sooner, not later', () => {
    // A mapping polled every minute is stale after three, not after an hour.
    expect(syncState(mapping({ pollIntervalSeconds: 60, lastPollAt: agoSeconds(600) }), NOW)).toBe('stale');
  });

  it('calls a paused mapping paused, not stale', () => {
    // Switched off on purpose. Ageing it into a warning reports a fault that
    // somebody deliberately created.
    expect(syncState(mapping({ isActive: false, lastPollAt: agoSeconds(999999) }), NOW)).toBe('paused');
  });

  it('distinguishes never polled from failing', () => {
    expect(syncState(mapping({ lastPollOk: null, lastPollAt: null }), NOW)).toBe('never');
  });

  it('treats an unreadable timestamp as stale rather than healthy', () => {
    // Absence of evidence is not evidence of health: stale sends somebody to
    // look, healthy sends nobody.
    expect(syncState(mapping({ lastPollAt: 'not a date' }), NOW)).toBe('stale');
  });

  it('does not make every mapping stale on a zero interval', () => {
    expect(syncState(mapping({ pollIntervalSeconds: 0, lastPollAt: agoSeconds(1) }), NOW)).toBe('healthy');
  });
});

describe('syncTone', () => {
  it('reserves danger for an actual failure', () => {
    expect(syncTone('erroring')).toBe('danger');
    expect(syncTone('stale')).toBe('warning');
    expect(syncTone('healthy')).toBe('ok');
  });

  it('keeps the two non-faults neutral', () => {
    expect(syncTone('paused')).toBe('neutral');
    expect(syncTone('never')).toBe('neutral');
  });
});

describe('one definition of health, not two', () => {
  /**
   * The settings card used to answer this question with its own pair of
   * helpers, and they disagreed with the dashboard in the one case that
   * matters: a mapping whose last poll SUCCEEDED read as "Polling" however long
   * ago that was, so a worker that stopped being scheduled looked healthy on
   * the page where somebody would have fixed it.
   *
   * Asserted against the source rather than the rendering because this
   * repository has no DOM test setup, and because what regressed was not a
   * pixel — it was a second copy of a rule. The same argument the SQL guards
   * make: the cheapest way to keep one definition is to fail when a second
   * appears.
   */
  const card = readFileSync('src/components/unifi-settings.tsx', 'utf8');

  it('the settings card derives health from this module', () => {
    expect(card).toMatch(/from '@\/lib\/ui\/sync-health'/);
    expect(card).toMatch(/syncState\(mapping\)/);
  });

  it('the guard above would have caught the old code', () => {
    // The helpers as they were, so a future reader can see the assertion is
    // matched against something real rather than against nothing.
    const old = `function healthTone(mapping: UnifiMapping): BadgeTone {\n` +
      `  return mapping.lastPollOk ? 'ok' : 'warning';\n}`;
    expect(old).toMatch(/function healthTone\b/);
  });

  it('...and has no local health helper of its own', () => {
    // The two that were here, by name, plus the shape of any replacement.
    expect(card).not.toMatch(/function healthTone\b/);
    expect(card).not.toMatch(/function healthLabel\b/);
    expect(card).not.toMatch(/lastPollOk \? 'Polling'/);
  });

  it('the dashboard widget derives it from the same place', () => {
    const widgets = readFileSync('src/components/widgets/index.tsx', 'utf8');
    expect(widgets).toMatch(/from '@\/lib\/ui\/sync-health'/);
  });
});
