/**
 * What actually reaches the clipboard.
 *
 * THE DEFECT THIS EXISTS FOR. The reveal button POSTed to
 * /api/secrets/:id/copy — a route that records a copy EVENT and answers
 * `{ auditEventUid }` — and then wrote `body.value` from that reply. No such
 * field exists, so `navigator.clipboard.writeText(undefined)` coerced its
 * argument and put the nine characters `undefined` on the clipboard, under a
 * green "Copied — recorded as a copy event."
 *
 * A test that clicked the button and asserted "the clipboard was written"
 * would have passed the whole time. So these assert the VALUE, and the first
 * of them reconstructs the original response shape rather than describing it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { copyAudited, copyFailureMessage, copyUnaudited } from '../../src/lib/ui/clipboard';

const PLAINTEXT = 'correct horse battery staple';

/** The copy route's real reply, verbatim. It has no `value`, and never did. */
const COPY_ROUTE_REPLY = { auditEventUid: '018f3a21-0000-7000-8000-00000000abcd' };

describe('copyAudited', () => {
  it('writes the value it was given, exactly', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const record = vi.fn().mockResolvedValue(true);

    const outcome = await copyAudited({ value: PLAINTEXT, record, write });

    expect(outcome).toBe('copied');
    expect(write).toHaveBeenCalledExactlyOnceWith(PLAINTEXT);
  });

  it('preserves a value the clipboard would otherwise mangle', async () => {
    // Trailing whitespace and newlines are real in this product: an SSH private
    // key is multi-line, and a password may legitimately end in a space.
    const awkward = '-----BEGIN KEY-----\nline two\n-----END KEY-----\n  ';
    const write = vi.fn().mockResolvedValue(undefined);

    await copyAudited({ value: awkward, record: async () => true, write });

    expect(write).toHaveBeenCalledExactlyOnceWith(awkward);
  });

  // ---------------------------------------------------------------------------
  // The original finding.
  // ---------------------------------------------------------------------------
  it('refuses the field the copy route does not return, instead of stringifying it', async () => {
    const write = vi.fn().mockResolvedValue(undefined);

    // Exactly what the old code did: read `value` off the recording response.
    const outcome = await copyAudited({
      value: (COPY_ROUTE_REPLY as { value?: string }).value,
      record: async () => true,
      write,
    });

    expect(outcome).toBe('nothing-to-copy');
    expect(write).not.toHaveBeenCalled();
    // The assertion that would have failed in September 2026.
    expect(write).not.toHaveBeenCalledWith('undefined');
  });

  it('refuses anything that is not a non-empty string', async () => {
    for (const value of [undefined, null, '', 0, 42, {}, [], { value: PLAINTEXT }, NaN, false]) {
      const write = vi.fn().mockResolvedValue(undefined);
      const record = vi.fn().mockResolvedValue(true);

      expect(await copyAudited({ value, record, write })).toBe('nothing-to-copy');
      expect(write).not.toHaveBeenCalled();
      // Nothing happened, so nothing is recorded as having happened.
      expect(record).not.toHaveBeenCalled();
    }
  });

  // ---------------------------------------------------------------------------
  // Order. An unaudited copy of a client credential is the case this product
  // exists to prevent.
  // ---------------------------------------------------------------------------
  it('records before it writes', async () => {
    const order: string[] = [];
    const record = vi.fn(async () => {
      order.push('record');
      return true;
    });
    const write = vi.fn(async () => {
      order.push('write');
    });

    await copyAudited({ value: PLAINTEXT, record, write });

    expect(order).toEqual(['record', 'write']);
  });

  it('writes nothing when the copy could not be recorded', async () => {
    const write = vi.fn().mockResolvedValue(undefined);

    // The route refused: no permission, no such secret, out of scope.
    expect(await copyAudited({ value: PLAINTEXT, record: async () => false, write })).toBe(
      'not-recorded',
    );
    // The fetch itself failed.
    expect(
      await copyAudited({
        value: PLAINTEXT,
        record: async () => {
          throw new TypeError('Failed to fetch');
        },
        write,
      }),
    ).toBe('not-recorded');

    expect(write).not.toHaveBeenCalled();
  });

  it('reports a refused clipboard, having already recorded the attempt', async () => {
    const record = vi.fn().mockResolvedValue(true);
    const write = vi.fn().mockRejectedValue(new DOMException('Write permission denied.'));

    const outcome = await copyAudited({ value: PLAINTEXT, record, write });

    // Deliberately asymmetric: the audit log may overstate what left the
    // building, never understate it.
    expect(outcome).toBe('clipboard-refused');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('says what went wrong for every outcome but success', () => {
    expect(copyFailureMessage('copied')).toBeNull();
    for (const outcome of ['nothing-to-copy', 'not-recorded', 'clipboard-refused'] as const) {
      expect(copyFailureMessage(outcome)).toMatch(/\S/);
    }
  });
});

describe('copyUnaudited', () => {
  it('writes the value with nothing to record', async () => {
    const write = vi.fn().mockResolvedValue(undefined);

    expect(await copyUnaudited('https://helm.example.com/api/auth/callback/oidc-acme', write)).toBe(
      'copied',
    );
    expect(write).toHaveBeenCalledExactlyOnceWith(
      'https://helm.example.com/api/auth/callback/oidc-acme',
    );
  });

  it('applies the same guard', async () => {
    const write = vi.fn().mockResolvedValue(undefined);

    expect(await copyUnaudited(undefined, write)).toBe('nothing-to-copy');
    expect(write).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// The class, not the instance.
//
// "A bug like this is often copy-pasted across similar components" — it had
// already been pasted once, from the reveal button into the OIDC card, where it
// happened to be harmless. The guard is only a guard if every copy button goes
// through it, so this fails on a new bare writeText rather than waiting for the
// next person to paste the wrong field into it.
// -----------------------------------------------------------------------------
const ROOT = join(import.meta.dirname, '..', '..');
const GUARD = join('src', 'lib', 'ui', 'clipboard.ts');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe('the clipboard has one door', () => {
  it('is reached only through src/lib/ui/clipboard.ts', () => {
    const offenders = sourceFiles('src')
      .filter((f) => f !== GUARD)
      .filter((f) => /navigator\s*\.\s*clipboard|clipboardData|execCommand\s*\(\s*['"]copy/.test(
        readFileSync(join(ROOT, f), 'utf8'),
      ));

    expect(offenders).toEqual([]);
  });
});
