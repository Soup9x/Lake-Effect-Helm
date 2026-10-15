/**
 * What a Postgres error may become on the way out.
 *
 * THE PROBLEM THIS SOLVES. The schema refuses things: 432 `RAISE EXCEPTION
 * 'helm: …'` statements with no ERRCODE, nine with `no_data_found`, and the
 * CHECK, UNIQUE and FOREIGN KEY constraints under them. Those messages were
 * written to be read — "configure a mail relay before adding an email
 * destination" — and until this file existed every one of them that a route had
 * not translated by hand came back as a bare 500 "internal error" with a stack
 * trace in the log. Seven routes carried their own copies of the same switch;
 * the other eighty did not.
 *
 * TWO RULES, inherited from errors.ts:
 *
 *   1. Nothing Postgres composed itself reaches a client. Its wording names
 *      relations, columns and constraints ("new row for relation smtp_setting
 *      violates check constraint smtp_pin_shape"), which is schema to a caller
 *      who may be a co-managed customer. Those become a fixed sentence per
 *      SQLSTATE, and the original goes to the server log under the request id.
 *
 *   2. A message Helm raised itself, prefixed `helm: `, passes through with
 *      the prefix removed. That prefix is the schema's declaration that the
 *      sentence after it is for a person; the handler already honoured it for
 *      insufficient_privilege, and this extends the same contract to every
 *      other code.
 *
 * WHAT IS NOT MAPPED, deliberately: anything not listed is still a 500. A
 * serialisation failure, a statement timeout or a disconnected pool is a fault,
 * and reporting one as a client mistake would hide an outage behind a 400.
 *
 * Routes may still translate a code themselves for a more specific sentence —
 * "a client with the slug "acme" already exists" beats "that already exists" —
 * and the handler lets an ApiError thrown inside a route win. This is the
 * floor, not the ceiling.
 */
import { ApiError } from './errors';

export interface PostgresErrorShape {
  readonly code: string;
  readonly message: string;
  readonly constraint: string | undefined;
}

/**
 * Duck-typed rather than instanceof: postgres.js does not export its error
 * class, and matching on the shape is more robust than reaching into the
 * driver's internals for one that may be renamed.
 */
export function postgresError(error: unknown): PostgresErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, message, constraint_name } = error as {
    code?: unknown;
    message?: unknown;
    constraint_name?: unknown;
  };
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return null;
  return {
    code,
    message: typeof message === 'string' ? message : '',
    constraint: typeof constraint_name === 'string' ? constraint_name : undefined,
  };
}

/**
 * The sentence Helm wrote for a person, or null when Postgres composed the
 * message itself.
 *
 * Only the first line is considered: postgres.js puts the primary message
 * there and a plpgsql CONTEXT block after it, and the context names the
 * function that raised, which is schema.
 */
export function helmMessage(error: PostgresErrorShape): string | null {
  const first = error.message.split('\n')[0] ?? '';
  return first.startsWith('helm: ') ? first.slice('helm: '.length).trim() : null;
}

/**
 * The mapping. Each entry is a status class and the sentence used when the
 * database's own wording cannot be shown.
 */
const MAPPED: Record<string, { kind: 'invalid' | 'conflict' | 'not_found'; fallback: string }> = {
  // raise_exception: a plpgsql RAISE with no ERRCODE. Only Helm's own raises
  // are mapped — see below, where a non-`helm:` P0001 stays a 500.
  P0001: { kind: 'invalid', fallback: '' },
  // no_data_found: a lookup Helm made inside a function came back empty.
  P0002: { kind: 'not_found', fallback: 'not found' },
  // invalid_parameter_value: a trigger refusing a value it validated itself,
  // such as a time zone name.
  '22023': { kind: 'invalid', fallback: 'a value is not acceptable' },
  // unique_violation.
  '23505': { kind: 'conflict', fallback: 'that already exists' },
  // exclusion_violation.
  '23P01': { kind: 'conflict', fallback: 'that overlaps something that already exists' },
  // foreign_key_violation: on an insert the target is missing; on a delete
  // something still depends on the row. One sentence has to cover both.
  '23503': { kind: 'invalid', fallback: 'that refers to something that does not exist, or is still in use' },
  // check_violation.
  '23514': { kind: 'invalid', fallback: 'a value does not satisfy a validation rule' },
  // not_null_violation.
  '23502': { kind: 'invalid', fallback: 'a required value is missing' },
  // invalid_text_representation: "not-an-ip" cast to inet, "abc" to integer.
  '22P02': { kind: 'invalid', fallback: 'a value has the wrong format' },
  // string_data_right_truncation.
  '22001': { kind: 'invalid', fallback: 'a value is too long' },
  // numeric_value_out_of_range.
  '22003': { kind: 'invalid', fallback: 'a number is out of range' },
  // invalid_datetime_format / datetime_field_overflow.
  '22007': { kind: 'invalid', fallback: 'a date or time has the wrong format' },
  '22008': { kind: 'invalid', fallback: 'a date or time is out of range' },
  // serialization_failure / deadlock_detected: two writers crossed. The client
  // can retry; the server cannot do it for them inside a finished request.
  '40001': { kind: 'conflict', fallback: 'the request conflicted with another change; retry' },
  '40P01': { kind: 'conflict', fallback: 'the request conflicted with another change; retry' },
};

/**
 * The ApiError a database refusal becomes, or null when it is a fault.
 *
 * insufficient_privilege (42501) is not here: the handler maps it itself,
 * because the step-up variant needs the error's DETAIL and the two must be
 * told apart before either becomes a 403.
 */
export function mapDatabaseError(error: unknown): ApiError | null {
  const pg = postgresError(error);
  if (!pg) return null;

  const entry = MAPPED[pg.code];
  if (!entry) return null;

  const own = helmMessage(pg);
  // A RAISE Helm did not write — an extension, a hand-run function — is a
  // fault until somebody decides what it means.
  if (pg.code === 'P0001' && own === null) return null;

  const message = own ?? entry.fallback;
  switch (entry.kind) {
    case 'invalid':
      return ApiError.invalid(message);
    case 'conflict':
      return ApiError.conflict(message);
    case 'not_found':
      return ApiError.notFound(message);
  }
}
