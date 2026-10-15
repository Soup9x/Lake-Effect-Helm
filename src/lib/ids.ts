/**
 * Whether a string is shaped like a UUID — any version, as z.guid() accepts and
 * PostgreSQL stores (see the note in lib/api/errors.ts on why not z.uuid()).
 *
 * For page params, checked before the value reaches a `::uuid` cast. Without
 * it a malformed URL segment was a Postgres syntax error, which rendered the
 * error page with a digest instead of a 404.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
