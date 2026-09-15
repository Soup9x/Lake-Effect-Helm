/**
 * Argon2id hashing, and the policy a candidate password has to satisfy.
 *
 * Local passwords exist so that an MSP can reach its clients' credentials when
 * Entra is unreachable. That makes them the one credential in Helm that is
 * guessable — everything else is a random token or a certificate — so the two
 * halves of this file carry most of the weight:
 *
 *   hashing  Argon2id, memory-hard, so an exfiltrated table is expensive to
 *            attack offline rather than a weekend's GPU time.
 *   policy   length first, dictionary-shaped rejections second. A twelve
 *            character passphrase beats an eight character one with a symbol
 *            bolted on, and the rules below say so.
 */
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { timingSafeEqual } from 'node:crypto';
import { scoreStrength } from '../crypto/blind-index';

/**
 * OWASP's 2024 floor is m=19456 (19 MiB), t=2, p=1. Helm runs above it.
 *
 * 64 MiB and three passes costs roughly 260ms on a modern server core. That is
 * a deliberate trade: sign-in is not a hot path (a technician does it a handful
 * of times a day, and a database session then lasts eight hours), while the
 * offline attack this defends against is the entire threat model. The memory
 * cost is what matters most — it is what makes a GPU or an ASIC a poor fit.
 *
 * Raising these later is safe and does not need a mass reset: the parameters
 * travel inside each stored PHC string, and needsRehash() below upgrades a hash
 * on its owner's next successful sign-in, when the plaintext is briefly in hand.
 */
// Algorithm.Argon2id. Spelled as its numeric value because @node-rs/argon2
// declares Algorithm as an ambient `const enum`, which verbatimModuleSyntax
// refuses to import — the enum has no runtime representation to import.
const ARGON2ID = 2;

export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 65536, // KiB
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * A pre-computed hash to verify against when the account does not exist.
 *
 * Without this, "no such user" returns in a millisecond and "wrong password"
 * returns in 260, which is a user-enumeration oracle anyone can read with a
 * stopwatch. It matters more here than on a typical login form: the accounts
 * worth enumerating are an MSP's administrators, and this form is the one that
 * still answers when the identity provider is down.
 *
 * Computed once, lazily, on first use — hashing at module load would add a
 * quarter of a second to every worker and CLI start for something most of them
 * never touch.
 */
let dummyHashPromise: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= argon2Hash('helm-nonexistent-account-placeholder', ARGON2_PARAMS);
  return dummyHashPromise;
}

/** Hash a password. Returns the full PHC string, salt and parameters included. */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2Hash(plaintext, ARGON2_PARAMS);
}

/**
 * Verify a candidate against a stored PHC string.
 *
 * Never throws. A malformed or truncated hash is a verification failure, not a
 * 500: a row that somehow holds garbage must fail closed, and an error that
 * escapes here would distinguish "corrupt hash" from "wrong password" in the
 * response, which is a worse answer than "no".
 */
export async function verifyPassword(plaintext: string, phc: string): Promise<boolean> {
  try {
    return await argon2Verify(phc, plaintext);
  } catch {
    return false;
  }
}

/**
 * Spend the same wall-clock time as a real verification, and return false.
 *
 * Call this on the unknown-account path. It is a real Argon2 verification
 * against a real hash, not a sleep, so it tracks the cost of the genuine path
 * automatically when ARGON2_PARAMS changes.
 */
export async function verifyDummyPassword(plaintext: string): Promise<false> {
  await verifyPassword(plaintext, await dummyHash());
  return false;
}

/**
 * True when a stored hash was made with weaker parameters than ARGON2_PARAMS.
 *
 * The caller re-hashes on the next successful sign-in. Parsing is deliberately
 * tolerant: anything unrecognised returns true, because "I cannot tell how
 * strong this is" should upgrade it rather than leave it alone.
 */
export function needsRehash(phc: string): boolean {
  const parsed = parsePhc(phc);
  if (!parsed) return true;
  if (parsed.algorithm !== 'argon2id') return true;
  return (
    parsed.memoryCost < ARGON2_PARAMS.memoryCost ||
    parsed.timeCost < ARGON2_PARAMS.timeCost ||
    parsed.parallelism !== ARGON2_PARAMS.parallelism
  );
}

export interface ParsedPhc {
  algorithm: string;
  version: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/** Parse `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`. Null if it is not that. */
export function parsePhc(phc: string): ParsedPhc | null {
  const match = /^\$(argon2(?:id|i|d))\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
  if (!match) return null;
  return {
    algorithm: match[1]!,
    version: Number(match[2]),
    memoryCost: Number(match[3]),
    timeCost: Number(match[4]),
    parallelism: Number(match[5]),
  };
}

/**
 * Has this password been used before?
 *
 * Every stored PHC string carries its own salt, so there is no digest to
 * compare — each one has to be verified in turn. That is deliberately
 * expensive, which is why the history is capped at five in the schema: an
 * unbounded history would make every password change a denial-of-service lever
 * against the server that has to check it.
 */
export async function isReused(plaintext: string, history: readonly string[]): Promise<boolean> {
  for (const previous of history) {
    if (await verifyPassword(plaintext, previous)) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Policy
// -----------------------------------------------------------------------------

/**
 * Twelve, not eight.
 *
 * NIST SP 800-63B puts the floor at eight and drops the composition rules that
 * produce "Summer2024!". Helm asks for twelve because a local Helm password
 * unlocks every credential the holder's role can reach, and because the people
 * typing it are technicians with password managers, not the general public.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Argon2 has no practical input limit; this caps the work an attacker can ask for. */
export const MAX_PASSWORD_LENGTH = 256;

/** Minimum scoreStrength() band: 0 very weak … 4 strong. */
const MIN_STRENGTH_SCORE = 2;

/**
 * Passwords that are common enough to be in the first thousand guesses of any
 * credential-stuffing run. Not a substitute for a real breach corpus — an
 * operator who wants one should front Helm with a Have I Been Pwned range
 * lookup — but it catches the handful that get typed into a new deployment on
 * the first day, which is exactly when the admin account is most exposed.
 */
const BANNED = new Set([
  'password', 'passw0rd', 'password1', 'password123', 'p@ssw0rd', 'p@ssword',
  'administrator', 'letmein', 'welcome', 'welcome1', 'qwerty', 'qwerty123',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'changeme', 'default', 'secret', 'trustno1', 'abc123', 'test123',
  'helm', 'lakeeffect', 'lakeeffecthelm', 'msp', 'itglue', 'hudu',
]);

export interface PasswordPolicyContext {
  /** Rejected as a component: a password containing the account's own address. */
  email?: string;
  name?: string;
}

export interface PolicyResult {
  ok: boolean;
  /** Every failure, not just the first: a form that reveals one rule per attempt is a bad form. */
  problems: string[];
  score: number;
}

/**
 * Check a candidate password.
 *
 * Returns ALL the problems rather than the first, because the alternative is a
 * person submitting six times to discover six rules, and the person doing that
 * during an outage is already having a bad day.
 */
export function checkPasswordPolicy(
  plaintext: string,
  context: PasswordPolicyContext = {},
): PolicyResult {
  const problems: string[] = [];

  if (plaintext.length < MIN_PASSWORD_LENGTH) {
    problems.push(`must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (plaintext.length > MAX_PASSWORD_LENGTH) {
    problems.push(`must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  // Leading and trailing whitespace survives a copy-paste and then does not
  // survive the next one. Interior spaces are fine and passphrases need them.
  if (plaintext !== plaintext.trim()) {
    problems.push('must not start or end with a space');
  }
  if (/[\x00-\x08\x0e-\x1f\x7f]/.test(plaintext)) {
    problems.push('must not contain control characters');
  }

  const folded = plaintext.toLowerCase();
  const stripped = folded.replace(/[^a-z0-9]/g, '');

  if (BANNED.has(folded) || BANNED.has(stripped)) {
    problems.push('is one of the most commonly guessed passwords');
  }

  // Substrings of the account itself. "dana.whitfield2024" is long, scores
  // well, and is the first thing anyone targeting Dana would try.
  for (const part of identityFragments(context)) {
    if (part.length >= 4 && folded.includes(part)) {
      problems.push('must not contain your name or email address');
      break;
    }
  }

  const score = scoreStrength(plaintext);
  if (score < MIN_STRENGTH_SCORE) {
    problems.push('is too predictable — try a longer passphrase of several unrelated words');
  }

  return { ok: problems.length === 0, problems, score };
}

/** The pieces of an identity a password must not be built from. */
function identityFragments(context: PasswordPolicyContext): string[] {
  const fragments: string[] = [];

  if (context.email) {
    const local = context.email.split('@')[0]?.toLowerCase();
    if (local) {
      fragments.push(local);
      // "dana.whitfield" also rules out "dana" and "whitfield".
      fragments.push(...local.split(/[._+-]/).filter((p) => p.length >= 4));
    }
    const domain = context.email.split('@')[1]?.split('.')[0]?.toLowerCase();
    if (domain) fragments.push(domain);
  }

  if (context.name) {
    fragments.push(...context.name.toLowerCase().split(/\s+/).filter((p) => p.length >= 4));
  }

  return fragments;
}

/**
 * Compare two secrets without leaking their relationship through timing.
 *
 * Used on reset tokens, where the comparison is against a value an attacker
 * supplies and can iterate on. Lengths are compared first and in the clear;
 * that a token is the wrong length is not worth hiding.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
