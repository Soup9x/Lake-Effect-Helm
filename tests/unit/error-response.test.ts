/**
 * What a database refusal is allowed to tell the caller.
 *
 * errors.ts rule 1: nothing from a Postgres error reaches a client, who may be
 * a co-managed customer. The 42501 branch used to pass every message through,
 * which meant Postgres's own wording — table names, policy names — went out in
 * the 403 body. Helm's own `helm:` refusals are written for people and still
 * pass through.
 */
import { describe, expect, it, vi } from 'vitest';
import { errorResponse } from '../../src/lib/api/handler';

const pgError = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code: '42501', ...extra });

async function bodyOf(response: Response) {
  return (await response.json()) as { error: { code: string; message: string } };
}

describe('a 42501 from the database', () => {
  it("passes Helm's own refusal through, without the prefix", async () => {
    const response = errorResponse(pgError('helm: user:write is required to invite somebody'), 'r1');
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error.message).toBe('user:write is required to invite somebody');
  });

  it("does not repeat Postgres's own wording, which names the schema", async () => {
    for (const message of [
      'permission denied for table secret_version',
      'new row violates row-level security policy for table "membership"',
    ]) {
      const response = errorResponse(pgError(message), 'r2');
      expect(response.status).toBe(403);
      const body = JSON.stringify(await bodyOf(response));
      expect(body).not.toMatch(/secret_version|membership|row-level/);
      expect(body).toMatch(/does not permit/);
    }
  });

  it('still distinguishes a step-up refusal', async () => {
    const response = errorResponse(
      pgError('helm: step-up required', { detail: 'step_up_required' }),
      'r3',
    );
    expect((await bodyOf(response)).error.code).toBe('step_up_required');
  });
});

describe('an unknown error', () => {
  it('is a bare 500 carrying only the request id', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = errorResponse(new Error('column "secret" does not exist'), 'r4');
      expect(response.status).toBe(500);
      expect(JSON.stringify(await bodyOf(response))).not.toMatch(/column|secret/);
    } finally {
      log.mockRestore();
    }
  });
});
