/**
 * A server module may import COMPONENTS from a 'use client' module, and
 * nothing else.
 *
 * When a server module imports from a client module, the bundler replaces every
 * export with a client reference. A component survives that — rendering a
 * reference is the whole mechanism. Any other value does not: a string becomes
 * a function stub, a helper becomes something that throws "Attempted to call
 * X() from the server". The root layout imported THEME_SCRIPT from
 * components/theme-toggle.tsx exactly this way, rendered the stub's source as
 * its inline script, and the stored theme was never applied before first
 * paint. Nothing failed — vitest has no bundler, so 'use client' is inert here
 * and every test saw the real string.
 *
 * So the rule is read from the source: every non-type named import that a
 * server module takes from a client module must be a component name —
 * PascalCase with a lower-case letter in it, which THEME_SCRIPT is not.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const isClient = (source: string) =>
  /^['"]use client['"]/.test(source.trimStart().split('\n')[0] ?? '');

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const COMPONENT = /^[A-Z](?=.*[a-z])\w*$/;

function violations(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (isClient(source)) continue;

    // `import { a, type B, c as d } from '...'`, across lines; `import type` skipped.
    for (const match of source.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const target = resolveImport(file, match[2]!);
      if (!target || !isClient(readFileSync(target, 'utf8'))) continue;

      for (const raw of match[1]!.split(',')) {
        const spec = raw.trim();
        if (!spec || spec.startsWith('type ')) continue;
        const imported = spec.split(/\s+as\s+/)[0]!.trim();
        if (!COMPONENT.test(imported)) {
          found.push(`${file.slice(ROOT.length + 1)} imports '${imported}' from client module ${match[2]}`);
        }
      }
    }
  }
  return found;
}

describe('server modules and client modules', () => {
  it('imports nothing but components from a client module', () => {
    expect(violations()).toEqual([]);
  });

  it('would have caught THEME_SCRIPT', () => {
    expect(COMPONENT.test('THEME_SCRIPT')).toBe(false);
    expect(COMPONENT.test('ThemeToggle')).toBe(true);
  });
});
