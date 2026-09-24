/**
 * Schema barrel. `drizzle.config.ts` points here for drift detection.
 *
 * Remember what this layer is and is not: db/sql is the authority on the
 * database (RLS policies, SECURITY DEFINER routines, partitioning, generated
 * columns, grants). This is the typed query surface over it. `pnpm db:drift`
 * compares the two.
 */
export * from './_types';
export * from './enums';
export * from './tenancy';
export * from './identity';
export * from './secrets';
export * from './assets';
export * from './documentation';
export * from './integrations';
export * from './audit';
export * from './workspace';
export * from './network';
export * from './topology';
