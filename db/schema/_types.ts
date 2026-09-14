/**
 * Custom column types and shared column groups.
 *
 * Drizzle has no built-in `bytea` or `citext`, and Helm leans on both: every
 * envelope field is bytea, and every hostname/email is citext so that
 * comparisons match the database's own case-insensitive semantics rather than
 * silently diverging from the CHECK constraints in db/sql.
 */
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Binary column. Node's `Buffer` on both sides — node-postgres and postgres.js
 * both hand back Buffers for bytea, so no conversion is needed.
 *
 * Worth stating plainly: values in these columns are AES-256-GCM ciphertext,
 * nonces, tags and hashes. Nothing in the TypeScript layer should ever be
 * logging, serialising to JSON, or string-coercing one.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer; notNull: false; default: false }>({
  dataType: () => 'bytea',
});

/** Case-insensitive text. Matches the `citext` extension in the `extensions` schema. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/** PostgreSQL `inet`. Kept as a string; parse with a dedicated library if needed. */
export const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});

/** PostgreSQL `cidr`. */
export const cidr = customType<{ data: string; driverData: string }>({
  dataType: () => 'cidr',
});

/** PostgreSQL `macaddr`. */
export const macaddr = customType<{ data: string; driverData: string }>({
  dataType: () => 'macaddr',
});

/** `text[]`, which Drizzle can express but not with a concise helper. */
export const textArray = customType<{ data: string[]; driverData: string }>({
  dataType: () => 'text[]',
});

/** `uuid[]`, used for organisation scopes. */
export const uuidArray = customType<{ data: string[]; driverData: string }>({
  dataType: () => 'uuid[]',
});

/** `inet[]`, used for API token IP allow-lists. */
export const inetArray = customType<{ data: string[]; driverData: string }>({
  dataType: () => 'inet[]',
});

/** `citext[]`, used for certificate subject alternative names. */
export const citextArray = customType<{ data: string[]; driverData: string }>({
  dataType: () => 'citext[]',
});

/**
 * `tsvector`. Only ever a GENERATED column in this schema — never written
 * directly, so it exists here purely so the drift check can see it.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/** `integer[]`, used for alert lead-day thresholds. */
export const integerArray = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'integer[]',
});

/** Always `timestamptz`. A naive timestamp in an MSP tool spanning time zones is a bug. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * The audit columns nearly every mutable table carries.
 *
 * Spread into a table definition; `createdBy`/`updatedBy` are intentionally
 * plain uuid rather than `.references(...)` because the SQL migrations declare
 * those FKs with specific ON DELETE behaviour that varies per table.
 */
export const auditColumns = {
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
} as const;

/** Soft-delete marker. Present only on tables that actually support it. */
export const softDelete = {
  deletedAt: tstz('deleted_at'),
} as const;
