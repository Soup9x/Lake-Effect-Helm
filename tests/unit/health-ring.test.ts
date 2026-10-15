/**
 * The ring's arithmetic and its sentence.
 *
 * WHAT THESE COVER THAT THE DATABASE CANNOT. v_documentation_health returns
 * three counts from three independent SQL FILTER clauses. Whether they add up
 * is asserted against real rows in tests/integration/health.test.ts; what is
 * asserted here is what the INTERFACE does when they do not — because the
 * honest answer (hide the chart, show the numbers) is a branch that will never
 * run in normal operation and would therefore never be exercised at all.
 *
 * And the sentence. `healthSummary()` is the line people will quote at each
 * other, and it leads with the actionable half rather than the reassuring one.
 * A sentence worth getting right is worth testing.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_DAYS, HEALTH_DAYS_MAX, HEALTH_DAYS_MIN,
  healthSummary, segmentsAccountForAll, type DocumentationHealth,
} from '../../src/lib/health/window';
import { logoSrc } from '../../src/lib/ui/logo';
import { sniffImageType } from '../../src/lib/logos/service';

function health(partial: Partial<DocumentationHealth> = {}): DocumentationHealth {
  return {
    total: 10, current: 7, stale: 2, neverRevised: 1, unviewed: 3,
    lastRevisedAt: '2026-10-01T00:00:00.000Z',
    lastViewedAt: '2026-10-10T00:00:00.000Z',
    staleAfterDays: DEFAULT_HEALTH_DAYS,
    unviewedAfterDays: DEFAULT_HEALTH_DAYS,
    ...partial,
  };
}

describe('the segment identity', () => {
  it('holds for a consistent set of counts', () => {
    expect(segmentsAccountForAll(health())).toBe(true);
  });

  it('fails when a segment is lost, which is what the card checks before drawing', () => {
    // The case this exists for: somebody narrows one of the view's three
    // predicates and the arcs stop covering the circle. A ring with a gap in it
    // reads as a fourth category, so the card hides the chart instead.
    expect(segmentsAccountForAll(health({ stale: 1 }))).toBe(false);
  });

  it('fails when they overlap, not just when they leave a gap', () => {
    // The other direction, which a "sum <= total" check would have missed: two
    // predicates both matching the same row double-counts it, and the arcs
    // would wrap past twelve o'clock and overdraw the first segment.
    expect(segmentsAccountForAll(health({ current: 8 }))).toBe(false);
  });

  it('holds trivially for a client with nothing documented', () => {
    expect(segmentsAccountForAll(
      health({ total: 0, current: 0, stale: 0, neverRevised: 0 }),
    )).toBe(true);
  });
});

describe('the summary sentence', () => {
  it('says so plainly when there is nothing to measure', () => {
    expect(healthSummary(health({ total: 0, current: 0, stale: 0, neverRevised: 0 })))
      .toBe('Nothing is documented for this client yet.');
  });

  it('leads with what needs attention, not with what is fine', () => {
    const sentence = healthSummary(health({ total: 10, current: 7, stale: 2, neverRevised: 1 }));
    // Three of ten need a look, and that number comes first — a sentence
    // opening with "7 of 10 are current" is the same fact arranged to be
    // ignored.
    expect(sentence.startsWith('3 of 10')).toBe(true);
    expect(sentence).toContain('1 never revised since being created');
    expect(sentence).toContain('2 not revised in 180 days');
  });

  it('names only the segments that have anything in them', () => {
    // A client with stale records but none that were never revised should not
    // be told about "0 never revised"; a zero in a sentence reads as a
    // category somebody has to think about.
    const sentence = healthSummary(health({ total: 5, current: 3, stale: 2, neverRevised: 0 }));
    expect(sentence).toContain('2 not revised');
    expect(sentence).not.toContain('never revised');
  });

  it('says everything is current only when that is true', () => {
    expect(healthSummary(health({ total: 4, current: 4, stale: 0, neverRevised: 0 })))
      .toBe('All 4 records were revised in the last 180 days.');
  });

  it('uses the tenant"s window rather than the default', () => {
    // The number in the sentence has to be the one the measurement used, or the
    // sentence is wrong for every tenant that changed it.
    expect(healthSummary(health({ staleAfterDays: 90 }))).toContain('90 days');
  });
});

describe('the window bounds', () => {
  it('are the ones the route and the CHECK both name', () => {
    // The agreement with SQL is asserted in tests/integration/health.test.ts,
    // against the database. This is the cheap half: the constants exist and are
    // the right way round.
    expect(HEALTH_DAYS_MIN).toBeLessThan(HEALTH_DAYS_MAX);
    expect(DEFAULT_HEALTH_DAYS).toBeGreaterThanOrEqual(HEALTH_DAYS_MIN);
    expect(DEFAULT_HEALTH_DAYS).toBeLessThanOrEqual(HEALTH_DAYS_MAX);
  });
});

describe('which logo an avatar loads', () => {
  const ORG = '1a000000-0000-0000-0000-000000000002';

  it('prefers an upload over a pasted URL', () => {
    expect(logoSrc(ORG, true, 'https://acme.test/logo.png'))
      .toBe(`/api/organizations/${ORG}/logo`);
  });

  it('falls back to the pasted URL when nothing is uploaded', () => {
    expect(logoSrc(ORG, false, 'https://acme.test/logo.png'))
      .toBe('https://acme.test/logo.png');
  });

  it('is null when there is neither', () => {
    expect(logoSrc(ORG, false, null)).toBeNull();
  });

  it('treats an empty or blank pasted URL as absent', () => {
    // <img src=""> re-requests the current page, which on a client page means
    // fetching the whole HTML document again to render a 24-pixel avatar. An
    // empty string is what a cleared text input posts, so it arrives here.
    expect(logoSrc(ORG, false, '')).toBeNull();
    expect(logoSrc(ORG, false, '   ')).toBeNull();
  });

  it('trims a pasted URL rather than passing the whitespace through', () => {
    expect(logoSrc(ORG, false, '  https://acme.test/logo.png '))
      .toBe('https://acme.test/logo.png');
  });
});

describe('what a logo is allowed to be', () => {
  // Real signatures, because a sniffer tested against bytes somebody made up is
  // a sniffer tested against its own implementation.
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16)]);
  const WEBP = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'),
    Buffer.alloc(16),
  ]);

  it('recognises the four permitted formats', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('refuses an SVG however it is dressed up', () => {
    /*
     * THE CASE THE ALLOWLIST EXISTS FOR. An SVG served from Helm's own origin
     * can carry <script> and run with the reader's session. All three of these
     * are files a browser would happily render as an image if the Content-Type
     * said so, and the third is the one somebody would actually try: a valid
     * SVG whose upload claims to be a PNG.
     */
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?><svg><script>1</script></svg>')))
      .toBeNull();
    expect(sniffImageType(Buffer.from('﻿<svg onload="alert(1)"/>'))).toBeNull();
  });

  it('refuses HTML, which is the other thing that runs on this origin', () => {
    expect(sniffImageType(Buffer.from('<!doctype html><script>1</script>'))).toBeNull();
  });

  it('refuses a file too short to have a signature at all', () => {
    // Guards the subarray reads: a two-byte file must answer null rather than
    // comparing against a buffer shorter than the signature.
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it('refuses a RIFF container that is not WebP', () => {
    // A .wav is RIFF too, and checking only the first four bytes would accept
    // it as an image.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'),
      Buffer.alloc(16),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });

  it('refuses a GIF version nobody ships', () => {
    // GIF87a and GIF89a are the two that exist; GIF88a is somebody probing.
    const fake = Buffer.concat([Buffer.from('GIF88a', 'latin1'), Buffer.alloc(16)]);
    expect(sniffImageType(fake)).toBeNull();
  });
});
