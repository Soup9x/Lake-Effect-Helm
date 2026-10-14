/**
 * The datetime-local round trip, which silently moves deadlines when it is
 * wrong.
 *
 * `<input type="datetime-local">` holds local wall clock with no zone;
 * `sop_run_step.due_at` is a timestamptz and reaches the browser as a UTC ISO
 * string. So opening the dialog needs one conversion and saving it needs the
 * inverse — and the obvious version of the first, `iso.slice(0, 16)`, is wrong
 * in a way nothing would notice: it puts UTC into a field the browser reads as
 * local, and the save stores that shifted time. Open and save twice and the
 * deadline has moved twice.
 *
 * THE TIME ZONE IS FORCED, AND THAT IS THE POINT. This container runs with no
 * TZ set, so everything is UTC — where the correct conversion and the broken
 * one are character-for-character identical. A test suite in UTC cannot see
 * this bug at all. Node re-reads process.env.TZ per Date operation, so each
 * block below runs under a real offset and the guard asserts it took effect;
 * without that guard these tests would pass against the very bug they exist
 * for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromDateTimeLocalInput, toDateTimeLocalInput } from '../../src/lib/ui/format';

const ORIGINAL_TZ = process.env.TZ;
const offsetOf = (iso: string) => new Date(iso).getTimezoneOffset();

/** Runs a block under a named zone, and proves the zone actually applied. */
function inZone(zone: string, minimumOffset: number, body: () => void): void {
  describe(`in ${zone}`, () => {
    beforeAll(() => { process.env.TZ = zone; });
    afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

    it('is actually running in that zone, so these assertions mean something', () => {
      // Without this, a Node that ignored TZ would run every test below in UTC
      // and every one of them would pass while the slicing bug was present.
      expect(
        Math.abs(offsetOf('2026-06-15T12:00:00Z')),
        `TZ=${zone} did not take effect; these tests would be vacuous in UTC`,
      ).toBeGreaterThanOrEqual(minimumOffset);
    });

    body();
  });
}

inZone('America/Chicago', 300, () => {
  it('is NOT the first sixteen characters of the ISO string', () => {
    // The bug, named. 17:00Z is 12:00 in Chicago, and the field must say 12:00.
    const iso = '2026-10-20T17:00:00.000Z';
    expect(toDateTimeLocalInput(iso)).toBe('2026-10-20T12:00');
    expect(toDateTimeLocalInput(iso)).not.toBe(iso.slice(0, 16));
  });

  it('round-trips an instant unchanged', () => {
    for (const iso of [
      '2026-01-01T00:00:00.000Z',
      '2026-06-15T12:30:00.000Z',
      '2026-10-20T17:00:00.000Z',
      '2026-12-31T23:59:00.000Z',
    ]) {
      const field = toDateTimeLocalInput(iso);
      expect(fromDateTimeLocalInput(field), `${iso} did not survive the round trip`).toBe(iso);
    }
  });

  it('survives being opened and saved repeatedly', () => {
    // Drift compounds, so once is not the test: three passes would be three
    // shifts under the slicing bug.
    let value = '2026-10-20T17:00:00.000Z';
    for (let i = 0; i < 3; i += 1) {
      const next = fromDateTimeLocalInput(toDateTimeLocalInput(value));
      expect(next, `drifted on pass ${i + 1}`).toBe(value);
      value = next!;
    }
  });

  it('crosses a daylight-saving boundary without drifting', () => {
    // Chicago is UTC-6 in March and UTC-5 in November, so a conversion using
    // one fixed offset moves exactly one of these.
    expect(offsetOf('2026-03-28T12:00:00Z')).not.toBe(offsetOf('2026-11-01T12:00:00Z'));
    for (const iso of ['2026-03-28T12:00:00.000Z', '2026-11-01T12:00:00.000Z']) {
      expect(fromDateTimeLocalInput(toDateTimeLocalInput(iso)), iso).toBe(iso);
    }
  });

  it('reads a zoneless field as the reader"s own time', () => {
    // 12:00 in Chicago on that date is 17:00Z. Stated as a literal rather than
    // derived, so the test would notice the arithmetic silently inverting.
    expect(fromDateTimeLocalInput('2026-10-20T12:00')).toBe('2026-10-20T17:00:00.000Z');
  });
});

// A half-hour offset, because an implementation that pads or truncates to the
// hour passes everything above and fails here.
inZone('Asia/Kolkata', 330, () => {
  it('handles an offset that is not a whole number of hours', () => {
    expect(toDateTimeLocalInput('2026-10-20T17:00:00.000Z')).toBe('2026-10-20T22:30');
    expect(fromDateTimeLocalInput('2026-10-20T22:30')).toBe('2026-10-20T17:00:00.000Z');
  });

  it('round-trips across midnight, where the date itself changes', () => {
    // 20:00Z is 01:30 the NEXT day in Kolkata. A conversion that took the date
    // from the ISO string and the time from the local getters would be a day
    // out here and nowhere else.
    expect(toDateTimeLocalInput('2026-10-20T20:00:00.000Z')).toBe('2026-10-21T01:30');
    expect(fromDateTimeLocalInput('2026-10-21T01:30')).toBe('2026-10-20T20:00:00.000Z');
  });
});

describe('the empty and unusable cases', () => {
  it('is an empty field for nothing, and for a value that is not a date', () => {
    // An empty input cannot show "invalid", so this is what it holds.
    expect(toDateTimeLocalInput(null)).toBe('');
    expect(toDateTimeLocalInput(undefined)).toBe('');
    expect(toDateTimeLocalInput('')).toBe('');
    expect(toDateTimeLocalInput('not a date')).toBe('');
  });

  it('is null going back, rather than Invalid Date', () => {
    // The route would reject the string anyway, but a 400 on a typo in a date
    // picker is worse than sending nothing: null clears the due date, which is
    // a state the form offers in its own right.
    expect(fromDateTimeLocalInput('')).toBeNull();
    expect(fromDateTimeLocalInput('tomorrow afternoon')).toBeNull();
  });

  it('takes a Date as readily as a string', () => {
    const date = new Date('2026-10-20T17:00:00Z');
    expect(toDateTimeLocalInput(date)).toBe(toDateTimeLocalInput(date.toISOString()));
  });
});
