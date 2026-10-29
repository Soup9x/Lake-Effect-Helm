/**
 * What the registry says, field by field, against what a person recorded.
 *
 * PURE, so the asset page (to render) and POST /api/assets/:id/registry (to
 * check a request against the same rules) agree about what counts as a
 * difference, and a unit test can pin the comparisons down without a database.
 *
 * NOTHING HERE WRITES. 1140 keeps the registry's answer beside the recorded
 * columns; a person applies a value, or keeps theirs, and only the first of
 * those changes the domain.
 */
import type { RegistryDetails } from './rdap';

/** The fields a registry answer can fill, in the order the card lists them. */
export const VERIFIABLE_FIELDS = [
  { key: 'registrar', label: 'Registrar' },
  { key: 'registered_at', label: 'Registered' },
  { key: 'expires_at', label: 'Expires' },
  { key: 'nameservers', label: 'Nameservers' },
  { key: 'transfer_locked', label: 'Transfer locked' },
  { key: 'dnssec_enabled', label: 'DNSSEC' },
] as const;

export type VerifiableKey = (typeof VERIFIABLE_FIELDS)[number]['key'];

export const VERIFIABLE_KEYS: ReadonlySet<string> = new Set(VERIFIABLE_FIELDS.map((f) => f.key));

/**
 * matches: the registry agrees with what is recorded.
 * fill: nothing is recorded, and the registry has a value.
 * differs: both have a value, and they are not the same.
 * kept: it differs, and somebody already chose to keep theirs for this value.
 */
export type SuggestionState = 'matches' | 'fill' | 'differs' | 'kept';

export interface RegistrySuggestion {
  key: VerifiableKey;
  label: string;
  recorded: unknown;
  registry: unknown;
  state: SuggestionState;
}

/** A recorded date may arrive as a Date or as text; compare calendar days. */
function dayOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 10);
  return null;
}

/** One comparable form per field, or null for "nothing recorded". */
export function normalise(key: VerifiableKey, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (key) {
    case 'registered_at':
    case 'expires_at':
      return dayOf(value);
    case 'nameservers': {
      if (!Array.isArray(value)) return null;
      const names = [...new Set(value.map((v) => String(v).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))].sort();
      return names.length === 0 ? null : names.join(',');
    }
    case 'transfer_locked':
    case 'dnssec_enabled':
      return typeof value === 'boolean' ? String(value) : null;
    case 'registrar': {
      // Case and spacing are how one registrar's name is written, not which
      // registrar it is: "GoDaddy.com, LLC" and "godaddy.com,  llc" agree.
      const s = String(value).trim().replace(/\s+/g, ' ').toLowerCase();
      return s === '' ? null : s;
    }
  }
}

/**
 * Every field the registry said something about, against the recorded value.
 * A field the registry did not mention is left out: there is nothing to verify.
 *
 * DNSSEC is NOT NULL DEFAULT false on `domain`, so "nobody recorded it" and
 * "recorded as off" look the same; an unset false therefore reads as a
 * difference from a registry that says signed, and as a match otherwise.
 */
export function registrySuggestions(
  recorded: Record<string, unknown>,
  details: RegistryDetails | null,
  dismissed: Record<string, unknown> | null,
): RegistrySuggestion[] {
  if (!details) return [];
  const out: RegistrySuggestion[] = [];
  for (const field of VERIFIABLE_FIELDS) {
    const registry = details[field.key];
    const theirs = normalise(field.key, registry);
    if (theirs === null) continue;
    const ours = normalise(field.key, recorded[field.key]);
    let state: SuggestionState;
    if (ours === theirs) state = 'matches';
    else if (dismissed && normalise(field.key, dismissed[field.key]) === theirs) state = 'kept';
    else state = ours === null ? 'fill' : 'differs';
    out.push({ key: field.key, label: field.label, recorded: recorded[field.key] ?? null, registry, state });
  }
  return out;
}

/** Whether a suggestion is one a person still has to look at. */
export function needsReview(s: RegistrySuggestion): boolean {
  return s.state === 'fill' || s.state === 'differs';
}
