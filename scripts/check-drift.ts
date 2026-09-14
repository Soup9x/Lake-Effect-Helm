/**
 * Schema drift check.
 *
 * db/sql is the authority on the database; db/schema is the typed view of it.
 * When they disagree, TypeScript is lying about the shape of production data —
 * a column declared notNull that is actually nullable, or a `text` that is
 * really `char(3)`, produces runtime failures that the type system promised
 * could not happen.
 *
 * `drizzle-kit check` validates migration-file consistency, which is not the
 * same question. This compares the Drizzle schema against the LIVE catalog.
 *
 *   pnpm tsx scripts/check-drift.ts
 */
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from '../db/schema/index';

interface CatalogColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  not_null: boolean;
}

/**
 * Canonicalise a type name so that differences of spelling are not reported as
 * drift. `numeric(9, 6)` and `numeric(9,6)`, or `char(3)` and `character(3)`,
 * are the same type; Drizzle and format_type simply choose different aliases.
 */
const TYPE_ALIASES: Record<string, string> = {
  char: 'character',
  varchar: 'charactervarying',
  bool: 'boolean',
  int: 'integer',
  int4: 'integer',
  int2: 'smallint',
  int8: 'bigint',
  float8: 'doubleprecision',
  float4: 'real',
  decimal: 'numeric',
  timestamptz: 'timestampwithtimezone',
  timetz: 'timewithtimezone',
};

function normaliseType(raw: string): string {
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  // Split a trailing modifier, e.g. "char(3)" -> "char" + "(3)".
  const match = /^([a-z_]+)(\(.*\))?(\[\])?$/.exec(compact);
  if (!match) return compact;
  const [, base, modifier = '', arraySuffix = ''] = match;
  return `${TYPE_ALIASES[base!] ?? base}${modifier}${arraySuffix}`;
}

async function main(): Promise<number> {
  const sql = postgres({
    host: process.env.PGHOST ?? '/run/pgt',
    port: Number(process.env.PGPORT ?? 5433),
    user: process.env.PGUSER ?? 'postgres',
    database: process.env.PGDATABASE ?? 'helm',
    // Read the catalog directly: information_schema hides columns the
    // connecting role lacks privileges on, which would report false "missing".
    onnotice: () => {},
  });

  const rows = await sql<CatalogColumn[]>`
    SELECT c.relname                              AS table_name,
           a.attname                              AS column_name,
           format_type(a.atttypid, a.atttypmod)   AS data_type,
           a.attnotnull                           AS not_null
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname NOT LIKE 'audit\_log\_2%'
    ORDER BY c.relname, a.attnum
  `;

  const catalog = new Map<string, Map<string, CatalogColumn>>();
  for (const row of rows) {
    if (!catalog.has(row.table_name)) catalog.set(row.table_name, new Map());
    catalog.get(row.table_name)!.set(row.column_name, row);
  }

  const problems: string[] = [];
  const declaredTables = new Set<string>();

  for (const value of Object.values(schema)) {
    // Enums, custom types and helpers also live in the barrel.
    if (typeof value !== 'object' || value === null) continue;
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      continue;
    }

    declaredTables.add(config.name);
    const actual = catalog.get(config.name);
    if (!actual) {
      problems.push(`table ${config.name}: declared in Drizzle, absent from the database`);
      continue;
    }

    for (const column of config.columns) {
      const found = actual.get(column.name);
      if (!found) {
        problems.push(`${config.name}.${column.name}: declared in Drizzle, absent from the database`);
        continue;
      }
      const declaredType = normaliseType(column.getSQLType());
      const actualType = normaliseType(found.data_type);
      if (declaredType !== actualType) {
        problems.push(
          `${config.name}.${column.name}: Drizzle says ${column.getSQLType()}, database says ${found.data_type}`,
        );
      }
      if (column.notNull !== found.not_null) {
        problems.push(
          `${config.name}.${column.name}: Drizzle says ${column.notNull ? 'NOT NULL' : 'nullable'}, ` +
          `database says ${found.not_null ? 'NOT NULL' : 'nullable'}`,
        );
      }
    }

    for (const name of actual.keys()) {
      if (!config.columns.some((c) => c.name === name)) {
        problems.push(`${config.name}.${name}: present in the database, missing from Drizzle`);
      }
    }
  }

  for (const table of catalog.keys()) {
    if (!declaredTables.has(table)) {
      problems.push(`table ${table}: present in the database, not declared in Drizzle`);
    }
  }

  await sql.end();

  if (problems.length === 0) {
    console.log(`✓ no drift: ${declaredTables.size} tables match the database`);
    return 0;
  }
  console.error(`✗ ${problems.length} drift problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(2);
});
