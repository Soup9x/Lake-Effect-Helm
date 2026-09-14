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
 * `pnpm db:generate` is therefore used only for DRIFT DETECTION in CI: it
 * diffs `db/schema/*.ts` against the live database built by `db/sql/`. A
 * non-empty diff means the TypeScript types and the real schema disagree and
 * one of them has to be corrected by hand.
 */
export default {
  schema: './db/schema/index.ts',
  out: './db/migrations-generated',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL ?? '',
  },
  // Helm keeps application tables in `public` and all helper routines in `helm`.
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
} satisfies Config;
