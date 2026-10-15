/**
 * The documentation coverage grid: which kinds of thing each client has
 * documented, and how much of the taxonomy that adds up to.
 *
 * WHY "COVERAGE" AND NOT "COMPLETENESS", which is the whole honesty question
 * for this group. Helm can see what has been documented. It cannot see what
 * EXISTS — a client with no ISP circuit is not an incompletely documented
 * client, they are a client with no ISP circuit, and nothing in the database
 * distinguishes that from a circuit nobody wrote down. So a single
 * "73% documented" score would be wrong for most clients most of the time, and
 * a score people learn to ignore is worse than no score.
 *
 * What IS factual is coverage: this client has at least one record of 7 of the
 * 11 kinds you document. That sentence is true, it carries its own denominator,
 * and the grid shows the four zero cells behind it so the number can be acted
 * on rather than argued with. The summary table in docs/history/itg-parity.md asked for
 * "a per-type/per-client coverage query", and this is that, named the same way.
 *
 * FIELD-LEVEL COMPLETENESS IS DELIBERATELY NOT HERE. "How many of a record's
 * fields are filled" sounds like the better measure and is a trap at this
 * layer: decision 8 found that a flexible record's stored `data` has every
 * secret field REMOVED by the splitter, so a naive fill rate under-reports by
 * exactly the number of secret fields on every record, always. Doing it
 * properly means excluding the version's `secret_fields` pointers — real, but a
 * different feature, and documentation health is group I's subject.
 *
 * NO TRAFFIC LIGHTS. A red/amber/green threshold on a coverage percentage is an
 * invented constant pretending to be a judgement: there is no answer to "is 70%
 * bad" that holds across MSPs, and v_client_health already owns red/amber/green
 * for something that IS defined (expiry severity). So the badge states the
 * fraction and nothing more.
 */

/** One column of the grid: a built-in node type, or one of the tenant's own. */
export interface GridColumn {
  /** `device`, or `flex:<uuid>` for a tenant-defined type. */
  key: string;
  label: string;
  source: 'node' | 'flexible';
  /** Where the column header links, when there is somewhere sensible. */
  categorySlug?: string | undefined;
}

export interface GridRow {
  organizationId: string;
  organizationName: string;
  isMspInternal: boolean;
  /** Keyed by GridColumn.key. Absent means zero. */
  counts: Readonly<Record<string, number>>;
}

export interface Coverage {
  covered: number;
  total: number;
  /** 0–100, rounded. 0 when there is nothing to cover. */
  percent: number;
}

/**
 * How many of the grid's columns this row has at least one record in.
 *
 * Counts a column as covered on `>= 1`, not on any threshold: the claim is "at
 * least one record exists", which is the only claim the data supports.
 */
export function coverageOf(
  row: Pick<GridRow, 'counts'>,
  columns: readonly GridColumn[],
): Coverage {
  const total = columns.length;
  if (total === 0) return { covered: 0, total: 0, percent: 0 };
  const covered = columns.reduce(
    (sum, column) => sum + ((row.counts[column.key] ?? 0) > 0 ? 1 : 0),
    0,
  );
  return { covered, total, percent: Math.round((100 * covered) / total) };
}

/** The columns a row has nothing in, in grid order — what somebody can act on. */
export function gapsOf(
  row: Pick<GridRow, 'counts'>,
  columns: readonly GridColumn[],
): GridColumn[] {
  return columns.filter((column) => (row.counts[column.key] ?? 0) === 0);
}

/**
 * Total records per column, across the rows on screen.
 *
 * Deliberately across THE ROWS ON SCREEN rather than the whole tenant: the
 * figure sits under a column of a paginated table, and a total that counted
 * clients not shown would not add up to the column above it. A reader who adds
 * the column by hand and gets a different number stops trusting the table.
 */
export function columnTotals(
  rows: readonly GridRow[],
  columns: readonly GridColumn[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const column of columns) {
    totals[column.key] = rows.reduce((sum, row) => sum + (row.counts[column.key] ?? 0), 0);
  }
  return totals;
}

/**
 * How many of the rows on screen have at least one record in each column.
 *
 * The other half of a column's story, and the more useful half: "4 of 50
 * clients have a documented firewall" is a gap, where "212 devices" is just a
 * volume.
 */
export function columnClientCoverage(
  rows: readonly GridRow[],
  columns: readonly GridColumn[],
): Record<string, number> {
  const covered: Record<string, number> = {};
  for (const column of columns) {
    covered[column.key] = rows.reduce(
      (sum, row) => sum + ((row.counts[column.key] ?? 0) > 0 ? 1 : 0),
      0,
    );
  }
  return covered;
}
