/**
 * Generating a password: the arithmetic, kept apart from the button so it can
 * be tested without a browser.
 *
 * UNBIASED. Each character is drawn by rejection sampling from a
 * cryptographically secure source: a random byte is used only when it falls
 * below the largest multiple of the alphabet's size, so `byte % size` gives
 * every character the same chance. The obvious `byte % size` alone favours the
 * first few characters of any alphabet whose size does not divide 256.
 *
 * EVERY CHOSEN SET APPEARS. Plenty of systems refuse a password without a
 * digit or a symbol, and "regenerate until it happens to have one" is not a
 * feature. One character from each chosen set is placed first, the rest drawn
 * from the union, and the whole shuffled (Fisher–Yates, same unbiased draws),
 * so where those guaranteed characters land is not predictable either.
 */

export interface PasswordOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  /** Leave out characters easily misread on a call: 0 O o 1 l I | ` ' " and similar. */
  avoidAmbiguous: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: true,
};

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  // No space, no backslash, no quotes: the three that break a config file, a
  // shell or a CSV import more often than they add strength.
  symbols: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
} as const;

const AMBIGUOUS = new Set('0Oo1lI|`\'"'.split(''));

export type RandomBytes = (buffer: Uint8Array) => Uint8Array;

const cryptoBytes: RandomBytes = (buffer) => globalThis.crypto.getRandomValues(buffer);

/** A uniformly random integer in [0, n), n ≤ 256. */
function randomBelow(n: number, random: RandomBytes): number {
  const limit = 256 - (256 % n);
  const byte = new Uint8Array(1);
  for (;;) {
    random(byte);
    if (byte[0]! < limit) return byte[0]! % n;
  }
}

function alphabet(set: string, avoidAmbiguous: boolean): string {
  return avoidAmbiguous ? [...set].filter((c) => !AMBIGUOUS.has(c)).join('') : set;
}

export function generatePassword(options: PasswordOptions, random: RandomBytes = cryptoBytes): string {
  const length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.floor(options.length)));
  const chosen = (Object.keys(SETS) as (keyof typeof SETS)[])
    .filter((key) => options[key])
    .map((key) => alphabet(SETS[key], options.avoidAmbiguous));
  // Nothing ticked is not a password; fall back to letters and digits.
  const sets = chosen.length > 0 ? chosen : [alphabet(SETS.lower + SETS.upper + SETS.digits, true)];
  const all = sets.join('');

  const chars = sets.map((set) => set[randomBelow(set.length, random)]!);
  while (chars.length < length) chars.push(all[randomBelow(all.length, random)]!);

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomBelow(i + 1, random);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** Bits of entropy, for the strength line under the preview. */
export function passwordEntropyBits(options: PasswordOptions): number {
  const size = (Object.keys(SETS) as (keyof typeof SETS)[])
    .filter((key) => options[key])
    .reduce((sum, key) => sum + alphabet(SETS[key], options.avoidAmbiguous).length, 0) || 57;
  return Math.round(Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, options.length)) * Math.log2(size));
}
