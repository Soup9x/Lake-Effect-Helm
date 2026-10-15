import type { Config } from 'drizzle-kit';

/**
 * Drizzle is the *typed query layer* for Helm, not the migration authority.
 *
 * Hand-authored SQL under `db/sql/` is the source of truth for the database,
 * because RLS policies, SECURITY DEFINER functions, partitioning, generated
 * tsvector columns and column-level grants cannot be expressed in the Drizzle
 * schema DSL — and silently losing one of those is a tenant-isolation breach,
 * not a migration inconvenience.
 *
 * Drift detection is `pnpm db:drift` (scripts/check-drift.ts), which reads
 * these definitions directly and compares them with the live catalogue. This
 * file exists for `pnpm db:studio`, a browser over a development database, and
 * for nothing else: there is no `generate` step, because a generated migration
 * would be one that bypassed the SQL authority.
 */
export default {
  schema: './db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL ?? '',
  },
  // Helm keeps application tables in `public` and all helper routines in `helm`.
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
} satisfies Config;
