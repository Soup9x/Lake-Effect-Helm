import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMS,
  MIN_PASSWORD_LENGTH,
  checkPasswordPolicy,
  constantTimeEquals,
  hashPassword,
  isReused,
  needsRehash,
  parsePhc,
  verifyDummyPassword,
  verifyPassword,
} from '../../src/lib/auth/password';

describe('argon2id hashing', () => {
  it('produces a PHC string carrying the parameters it used', async () => {
    const phc = await hashPassword('correct horse battery staple');
    const parsed = parsePhc(phc);

    expect(parsed).not.toBeNull();
    expect(parsed!.algorithm).toBe('argon2id');
    expect(parsed!.memoryCost).toBe(ARGON2_PARAMS.memoryCost);
    expect(parsed!.timeCost).toBe(ARGON2_PARAMS.timeCost);
    expect(parsed!.parallelism).toBe(ARGON2_PARAMS.parallelism);
  });

  it('salts, so the same password twice gives different hashes', async () => {
    const [a, b] = await Promise.all([hashPassword('same input'), hashPassword('same input')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same input', a)).toBe(true);
    expect(await verifyPassword('same input', b)).toBe(true);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const phc = await hashPassword('a passphrase of several words');
    expect(await verifyPassword('a passphrase of several words', phc)).toBe(true);
    expect(await verifyPassword('a passphrase of several word', phc)).toBe(false);
    expect(await verifyPassword('', phc)).toBe(false);
  });

  it('fails closed on a corrupt hash instead of throwing', async () => {
    // A row holding garbage must be a failed sign-in, not a 500 that
    // distinguishes "corrupt" from "wrong" in the response.
    expect(await verifyPassword('anything', 'not-a-phc-string')).toBe(false);
    expect(await verifyPassword('anything', '$argon2id$v=19$m=65536,t=3,p=1$AAAA')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });

  it('spends real Argon2 time on the unknown-account path', async () => {
    const real = await hashPassword('a passphrase of several words');

    const startReal = performance.now();
    await verifyPassword('wrong guess entirely', real);
    const realMs = performance.now() - startReal;

    const startDummy = performance.now();
    const outcome = await verifyDummyPassword('wrong guess entirely');
    const dummyMs = performance.now() - startDummy;

    expect(outcome).toBe(false);
    // Within a factor of three either way. A sleep-based stub, or a path that
    // skipped the hash entirely, would be orders of magnitude apart — which is
    // the enumeration oracle this exists to close.
    expect(dummyMs).toBeGreaterThan(realMs / 3);
    expect(dummyMs).toBeLessThan(realMs * 3);
  });
});

describe('needsRehash', () => {
  it('leaves a current hash alone', async () => {
    expect(needsRehash(await hashPassword('current parameters here'))).toBe(false);
  });

  it('upgrades a hash made with weaker parameters', () => {
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=65536,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('upgrades anything it cannot parse or recognise', () => {
    // "I cannot tell how strong this is" must upgrade, not leave it alone.
    expect(needsRehash('bcrypt$2b$12$whatever')).toBe(true);
    expect(needsRehash('$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('password reuse', () => {
  it('finds a password anywhere in the history', async () => {
    const history = await Promise.all([
      hashPassword('first passphrase used'),
      hashPassword('second passphrase used'),
      hashPassword('third passphrase used'),
    ]);

    expect(await isReused('second passphrase used', history)).toBe(true);
    expect(await isReused('never used before now', history)).toBe(false);
    expect(await isReused('anything', [])).toBe(false);
  });
});

describe('password policy', () => {
  const accepted = [
    'correct horse battery staple',
    'Tr0ubad0ur&3xtras!',
    'seventeen purple lanterns',
  ];

  it.each(accepted)('accepts %j', (candidate) => {
    expect(checkPasswordPolicy(candidate).ok).toBe(true);
  });

  it('rejects anything shorter than the floor', () => {
    const result = checkPasswordPolicy('Sh0rt!');
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(`must be at least ${MIN_PASSWORD_LENGTH} characters`);
  });

  it('rejects the passwords a stuffing run tries first', () => {
    for (const candidate of ['password123', 'Password123', 'changeme', 'lakeeffecthelm']) {
      expect(checkPasswordPolicy(candidate).ok).toBe(false);
    }
  });

  it('rejects a password built out of the account it protects', () => {
    const context = { email: 'dana.whitfield@northwind.example.com', name: 'Dana Whitfield' };

    // Long, mixed case, digits and a symbol — and the first thing anyone
    // targeting Dana would try.
    const result = checkPasswordPolicy('Dana.Whitfield#2024', context);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('must not contain your name or email address');

    expect(checkPasswordPolicy('whitfield-lives-here', context).ok).toBe(false);
    expect(checkPasswordPolicy('northwind is my employer', context).ok).toBe(false);
    // The same password without the identity in it is fine.
    expect(checkPasswordPolicy('seventeen purple lanterns', context).ok).toBe(true);
  });

  it('rejects leading and trailing space, and allows it in the middle', () => {
    expect(checkPasswordPolicy('  padded passphrase  ').problems)
      .toContain('must not start or end with a space');
    expect(checkPasswordPolicy('interior spaces are fine').ok).toBe(true);
  });

  it('rejects control characters', () => {
    const withNul = `passphrase${String.fromCharCode(0)}here now`;
    expect(checkPasswordPolicy(withNul).problems)
      .toContain('must not contain control characters');
  });

  it('reports every problem at once, not one per attempt', () => {
    const result = checkPasswordPolicy('abc', { email: 'abc@example.com' });
    expect(result.problems.length).toBeGreaterThan(1);
  });

  it('caps length, so a verification cannot be made arbitrarily expensive', () => {
    expect(checkPasswordPolicy('x'.repeat(4096)).ok).toBe(false);
  });
});

describe('constantTimeEquals', () => {
  it('compares equal and unequal strings correctly', () => {
    expect(constantTimeEquals('a-reset-token-value', 'a-reset-token-value')).toBe(true);
    expect(constantTimeEquals('a-reset-token-value', 'a-reset-token-valuf')).toBe(false);
    expect(constantTimeEquals('short', 'much longer value')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});
