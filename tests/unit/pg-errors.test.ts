/**
 * What a database refusal becomes on the way out.
 *
 * The schema raises 432 `helm:` messages written for a person, and before
 * pg-errors.ts every one a route had not translated by hand was a 500. These
 * tests pin the contract: Helm's own wording passes through, Postgres's own
 * wording never does, and anything unlisted stays a fault.
 */
import { describe, expect, it } from 'vitest';
import { helmMessage, mapDatabaseError, postgresError } from '../../src/lib/api/pg-errors';
import { errorResponse } from '../../src/lib/api/handler';

/** The shape postgres.js throws, minus the parts that do not matter here. */
function pg(code: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

describe('postgresError', () => {
  it('recognises the driver shape by its SQLSTATE', () => {
    expect(postgresError(pg('23505', 'x', { constraint_name: 'thing_uk' }))).toEqual({
      code: '23505',
      message: 'x',
      constraint: 'thing_uk',
    });
  });

  it('ignores anything that is not one', () => {
    expect(postgresError(new Error('plain'))).toBeNull();
    expect(postgresError({ code: 'ECONNRESET' })).toBeNull();
    expect(postgresError(null)).toBeNull();
    expect(postgresError('23505')).toBeNull();
  });
});

describe('helmMessage', () => {
  it('returns the sentence after the prefix, first line only', () => {
    const shape = postgresError(
      pg('P0001', 'helm: configure a mail relay first\nCONTEXT: PL/pgSQL function helm.x() line 3'),
    )!;
    expect(helmMessage(shape)).toBe('configure a mail relay first');
  });

  it('returns null for wording Postgres composed', () => {
    const shape = postgresError(pg('23514', 'new row for relation "smtp_setting" violates check constraint "smtp_pin_shape"'))!;
    expect(helmMessage(shape)).toBeNull();
  });
});

describe('mapDatabaseError', () => {
  it("passes a `helm:` RAISE through as a 400 with Helm's own sentence", () => {
    const mapped = mapDatabaseError(pg('P0001', 'helm: configure a mail relay before adding an email destination'));
    expect(mapped?.status).toBe(400);
    expect(mapped?.code).toBe('invalid_request');
    expect(mapped?.message).toBe('configure a mail relay before adding an email destination');
  });

  it('leaves a RAISE Helm did not write as a fault', () => {
    expect(mapDatabaseError(pg('P0001', 'something an extension said'))).toBeNull();
  });

  it('never repeats wording Postgres composed', () => {
    const mapped = mapDatabaseError(
      pg('23514', 'new row for relation "smtp_setting" violates check constraint "smtp_pin_shape"', {
        constraint_name: 'smtp_pin_shape',
      }),
    );
    expect(mapped?.status).toBe(400);
    expect(mapped?.message).not.toMatch(/smtp|relation|constraint/);
  });

  it('maps the constraint family to the right status class', () => {
    expect(mapDatabaseError(pg('23505', 'duplicate key value'))?.status).toBe(409);
    expect(mapDatabaseError(pg('23P01', 'conflicting key value'))?.status).toBe(409);
    expect(mapDatabaseError(pg('23503', 'violates foreign key constraint'))?.status).toBe(400);
    expect(mapDatabaseError(pg('23502', 'null value in column'))?.status).toBe(400);
    expect(mapDatabaseError(pg('22P02', 'invalid input syntax for type inet: "not-an-ip"'))?.status).toBe(400);
    expect(mapDatabaseError(pg('22001', 'value too long'))?.status).toBe(400);
    expect(mapDatabaseError(pg('22023', 'helm: not a valid time zone: Mars/Olympus'))?.message).toBe(
      'not a valid time zone: Mars/Olympus',
    );
    expect(mapDatabaseError(pg('P0002', 'helm: no such site'))?.status).toBe(404);
    expect(mapDatabaseError(pg('40001', 'could not serialize access'))?.status).toBe(409);
  });

  it('leaves faults alone', () => {
    // statement timeout, connection failure, undefined function: operator problems.
    expect(mapDatabaseError(pg('57014', 'canceling statement due to statement timeout'))).toBeNull();
    expect(mapDatabaseError(pg('08006', 'connection failure'))).toBeNull();
    expect(mapDatabaseError(pg('42883', 'function helm.nope() does not exist'))).toBeNull();
  });

  it('does not intercept insufficient_privilege, which the handler maps itself', () => {
    expect(mapDatabaseError(pg('42501', 'helm: user:write is required'))).toBeNull();
  });
});

describe('errorResponse', () => {
  const body = async (response: Response) => (await response.json()) as { error: { code: string; message: string } };

  it('turns a `helm:` RAISE into a 400 the client can act on', async () => {
    const response = errorResponse(pg('P0001', 'helm: configure a mail relay first'), 'req-1');
    expect(response.status).toBe(400);
    expect((await body(response)).error).toMatchObject({
      code: 'invalid_request',
      message: 'configure a mail relay first',
    });
    expect(response.headers.get('x-request-id')).toBe('req-1');
  });

  it('still maps insufficient_privilege to 403, step-up variant included', async () => {
    const plain = errorResponse(pg('42501', 'helm: user:write is required to invite somebody'), 'r');
    expect(plain.status).toBe(403);
    expect((await body(plain)).error.message).toBe('user:write is required to invite somebody');

    const stepUp = errorResponse(pg('42501', 'permission denied', { detail: 'step_up_required' }), 'r');
    expect(stepUp.status).toBe(403);
    expect((await body(stepUp)).error.code).toBe('step_up_required');
  });

  it('keeps a fault a 500 that says nothing', async () => {
    const response = errorResponse(pg('57014', 'canceling statement due to statement timeout'), 'r');
    expect(response.status).toBe(500);
    expect((await body(response)).error.message).toBe('internal error');
  });
});
