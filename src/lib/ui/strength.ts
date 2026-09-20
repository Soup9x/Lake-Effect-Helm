/**
 * How a stored credential's strength score is presented.
 *
 * THE BUG THIS FILE EXISTS FOR. `secret_version.strength_score` is a BAND from
 * 0 to 4 — `scoreStrength()` in src/lib/crypto/blind-index.ts returns one, and
 * a CHECK constraint (`secret_version_strength_range`) refuses anything else.
 * Two pages compared it against 50:
 *
 *     {secret.strength_score !== null && secret.strength_score < 50 && (
 *       <Badge tone="warning">Weak ({secret.strength_score})</Badge>
 *     )}
 *
 * 4 < 50. So did 3, and 2, and every other value the column can hold. Every
 * credential in the product was badged weak, and the asset page printed the
 * number beside the word: "Weak (4)" on the strongest password the scorer can
 * recognise. Read as a percentage it is obvious what happened, and a percentage
 * is exactly what a reader assumes when a bare integer is compared to 50.
 *
 * Putting the threshold here, once, is the fix for the class of bug rather than
 * the instance: there is now one place that decides what "weak" means, it has
 * the band scale written next to it, and it is unit-tested against the
 * constraint's own range.
 */

/** The inclusive range `secret_version.strength_score` accepts. */
export const STRENGTH_MIN = 0;
export const STRENGTH_MAX = 4;

/**
 * Bands 0 and 1 are flagged; 2 and above are not.
 *
 * The same line src/lib/auth/password.ts draws for Helm's own login passwords
 * (MIN_STRENGTH_SCORE = 2), and drawing it in the same place for stored
 * credentials means a technician is not told one thing about their own password
 * and something else about a client's.
 *
 * Band 1 is under 40 estimated bits — an eight-character lowercase password.
 * Band 2 starts at 40, which a twelve-character lowercase password clears.
 */
const WEAK_AT_OR_BELOW = 1;

export function isWeakStrength(score: number | null | undefined): boolean {
  if (score === null || score === undefined) return false;
  return score <= WEAK_AT_OR_BELOW;
}

const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;

/**
 * The band as words.
 *
 * A bare integer out of five invites the reader to divide it by something, and
 * the last reader to do that divided it by a hundred.
 */
export function strengthLabel(score: number | null | undefined): string | null {
  if (score === null || score === undefined) return null;
  const clamped = Math.min(Math.max(Math.trunc(score), STRENGTH_MIN), STRENGTH_MAX);
  return LABELS[clamped] ?? null;
}
