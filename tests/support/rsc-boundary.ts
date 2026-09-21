/**
 * What React refuses to send from a Server Component to a Client Component.
 *
 * The rule: props crossing that boundary are SERIALISED. Plain data crosses.
 * A JSX element crosses, because an element is data. A *reference* to a
 * component or a function does not — React has nowhere to put it in the
 * payload and raises "Functions cannot be passed directly to Client
 * Components".
 *
 * The trap is that a lucide icon does not look like a function. It is
 * forwardRef(...), so `typeof` reports "object", and it reads at the call site
 * like any other value:
 *
 *     <SectionBrowser icon={MapPin} />
 *
 * There is no bundler here, so 'use client' is inert and nothing marks the
 * boundary at runtime — vitest imports every module the same way. So the
 * boundary is read from the SOURCE, where the directive is, and applied to the
 * element tree a page returns. That is enough to answer the only question that
 * matters: does this page hand a client component something React cannot send.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/** Every .tsx under src whose first line is the directive. */
function clientModules(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...clientModules(full));
    else if (entry.endsWith('.tsx')) {
      const first = readFileSync(full, 'utf8').trimStart().split('\n')[0] ?? '';
      if (/^['"]use client['"]/.test(first)) out.push(full);
    }
  }
  return out;
}

/**
 * The names of components declared in client modules.
 *
 * Matched by NAME rather than by identity, because the element tree holds the
 * function itself and comparing it to a re-imported copy is only reliable when
 * the module registry agrees — which it does here, but would stop doing so the
 * first time a test mocked one. A name is what the error message will say
 * anyway.
 */
export function clientComponentNames(): Set<string> {
  const names = new Set<string>();
  for (const file of clientModules()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^export function ([A-Z]\w*)/gm)) names.add(match[1]!);
    for (const match of source.matchAll(/^export const ([A-Z]\w*)\s*=/gm)) names.add(match[1]!);
  }
  return names;
}

export interface BoundaryViolation {
  /** The client component the prop was being passed to. */
  component: string;
  prop: string;
  /** What the value is, in the words the React error uses. */
  kind: 'function' | 'component reference';
  detail: string;
}

const FORWARD_REF = Symbol.for('react.forward_ref');
const MEMO = Symbol.for('react.memo');

/** A lucide icon, a memo(), or anything else React would call a component. */
function componentReference(value: unknown): string | null {
  if (typeof value === 'function') {
    // A class or function component passed by reference. An ordinary callback
    // is the same violation with a different cause, and both are reported.
    return value.name ? `function ${value.name}` : 'anonymous function';
  }
  if (value && typeof value === 'object') {
    const tagged = value as { $$typeof?: symbol; displayName?: string; render?: unknown };
    if (tagged.$$typeof === FORWARD_REF || tagged.$$typeof === MEMO) {
      return `forwardRef/memo component${tagged.displayName ? ` "${tagged.displayName}"` : ''}`;
    }
  }
  return null;
}

function nameOf(type: unknown): string | null {
  if (typeof type === 'function') return type.name || null;
  if (type && typeof type === 'object') {
    const tagged = type as { displayName?: string };
    return tagged.displayName ?? null;
  }
  return null;
}

/**
 * Walk a rendered element tree and report every unserialisable prop handed to a
 * client component.
 *
 * `children` is skipped: a child is an element, elements are data, and a client
 * component receiving server-rendered children is the supported pattern — it is
 * how every layout in this app works.
 */
export function findBoundaryViolations(
  tree: unknown,
  clients: Set<string> = clientComponentNames(),
): BoundaryViolation[] {
  const found: BoundaryViolation[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    const element = node as { type?: unknown; props?: Record<string, unknown> };
    const props = element.props;
    if (!props) return;

    const component = nameOf(element.type);
    if (component && clients.has(component)) {
      for (const [prop, value] of Object.entries(props)) {
        if (prop === 'children') continue;
        const detail = componentReference(value);
        if (detail) {
          found.push({
            component,
            prop,
            kind: typeof value === 'function' ? 'function' : 'component reference',
            detail,
          });
        }
      }
    }

    // Into children, and into every other prop: a prop holding an array of
    // elements (SectionBrowser's `rows`, whose cells are server-built JSX) is
    // where the next one of these will hide.
    for (const value of Object.values(props)) walk(value);
  };

  walk(tree);
  return found;
}

/** One line per violation, in the order a person would want to fix them. */
export function describeViolations(violations: BoundaryViolation[]): string {
  return violations
    .map((v) => `  <${v.component} ${v.prop}={…}>  is a ${v.detail}`)
    .sort()
    .join('\n');
}
