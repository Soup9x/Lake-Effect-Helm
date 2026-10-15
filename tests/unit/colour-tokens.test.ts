/**
 * Every colour utility names a token that exists.
 *
 * WHY THIS FILE EXISTS. `text-sev-ok` was written in two components and is
 * inert: the severity tokens are info, notice, warning, critical and expired,
 * and the green one is `--color-ok`. Tailwind generates nothing for an unknown
 * utility, so the class name sits in the markup looking deliberate while the
 * icon inherits whatever colour its parent had. Nothing caught it:
 *
 *   the type checker   a className is a string.
 *   the build          an unknown utility is not an error; Tailwind v4 scans
 *                      for candidates and silently keeps the ones it can
 *                      resolve.
 *   the test suite     components are not rendered (see pages.test.ts), and
 *                      rendering would not have helped — the element appears
 *                      with the class on it either way.
 *   a person looking   a severity icon that should be green and is merely
 *                      dark grey looks like a design choice.
 *
 * One of the two shipped. So the class is checked instead of the instance:
 * every `text-`, `bg-`, `border-`, `fill-`, `stroke-`, `ring-` and `from-`
 * utility whose name looks like one of this project's semantic colours must
 * name a `--color-*` custom property that globals.css actually declares, and
 * every `var(--color-*)` written inline must too.
 *
 * SCOPED TO THIS PROJECT'S OWN NAMES rather than all of Tailwind's. Checking
 * every utility would mean reimplementing Tailwind's palette — `text-white`,
 * `bg-red-500/10` and the arbitrary-value syntax are all legal and none of them
 * is a token here. The semantic families below are the ones globals.css
 * declares and the ones a typo is plausible in, which is exactly where the two
 * mistakes were.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const CSS = join(ROOT, 'src', 'app', 'globals.css');

/**
 * The semantic families. A utility whose first segment after the prefix is one
 * of these is one of ours and must resolve; anything else is Tailwind's own
 * palette or an arbitrary value and is none of this test's business.
 */
const FAMILIES = ['sev', 'ink', 'brand', 'ok', 'border', 'surface', 'danger'];

const PREFIXES = ['text', 'bg', 'border', 'fill', 'stroke', 'ring', 'from', 'to', 'via'];

function declaredTokens(): Set<string> {
  const css = readFileSync(CSS, 'utf8');
  const names = new Set<string>();
  for (const match of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) names.add(match[1]!);
  return names;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(join(ROOT, 'src'));
  return out;
}

describe('colour tokens', () => {
  const tokens = declaredTokens();

  it('declares the tokens this test is built on, so it is not vacuous', () => {
    // If globals.css is ever restructured so --color-* stops being the
    // spelling, every assertion below would pass by finding nothing. This is
    // the line that fails instead.
    expect(tokens.size, 'no --color-* tokens were found in globals.css').toBeGreaterThan(10);
    expect([...tokens]).toContain('ok');
    expect([...tokens]).toContain('sev-warning');
    // And the one that was wrong is still absent, which is why text-sev-ok was
    // inert. If somebody adds it, this test should be revisited rather than
    // silently start permitting the old spelling.
    expect(
      [...tokens],
      'a --color-sev-ok token now exists; see this file\'s header before using it',
    ).not.toContain('sev-ok');
  });

  it('uses no colour utility that names a token globals.css does not declare', () => {
    const bad: string[] = [];
    const pattern = new RegExp(
      `\\b(?:${PREFIXES.join('|')})-((?:${FAMILIES.join('|')})(?:-[a-z0-9]+)*)\\b`,
      'g',
    );

    for (const file of sourceFiles()) {
      if (file.endsWith('colour-tokens.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(pattern)) {
        const name = match[1]!;
        // Opacity modifiers (`bg-ok/10`) are stripped by the word boundary
        // already; a trailing numeric scale is Tailwind's own palette.
        if (tokens.has(name)) continue;
        bad.push(`${relative(ROOT, file)}: ${match[0]}`);
      }
    }

    expect(bad, 'these colour utilities name no declared token, so they render nothing')
      .toEqual([]);
  });

  it('writes no inline var(--color-…) that globals.css does not declare', () => {
    // The other half: the ring draws its arcs with an inline stroke, because an
    // SVG presentation attribute cannot take a utility class. A typo there is
    // just as invisible.
    const bad: string[] = [];
    for (const file of sourceFiles()) {
      if (file.endsWith('colour-tokens.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/var\(--color-([a-z0-9-]+)\)/g)) {
        if (!tokens.has(match[1]!)) bad.push(`${relative(ROOT, file)}: ${match[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
