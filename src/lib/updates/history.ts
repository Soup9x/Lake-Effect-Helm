/**
 * Every version of Helm this server has run (1230), for the History tab.
 *
 * Written by deploy/setup.sh, so it covers updates from the Updates page and
 * updates run by hand alike; read here through helm.helm_deploys(), which
 * requires tenant:write.
 */
import type { HelmTx } from '../db/client';

export interface DeployChange {
  pr: number | null;
  title: string;
}

export interface DeployEntry {
  id: string;
  /** 1 for the first version recorded on this server, counting up. */
  iteration: number;
  deployedAt: string;
  commit: string;
  previousCommit: string | null;
  title: string | null;
  changes: DeployChange[];
  /** From the Updates page, or `setup.sh` run by hand on the server. */
  source: 'page' | 'setup';
  /** The Helm user who asked for it, when it came from the page. */
  requestedBy: string | null;
  /** The account that ran sudo on the server, when it was run by hand. */
  hostUser: string | null;
  host: string | null;
  updateId: string | null;
  /** The updater's log, when it came from the page. */
  log: string | null;
}

interface Row {
  id: string;
  iteration: string | number;
  deployed_at: Date;
  commit: string;
  previous_commit: string | null;
  title: string | null;
  changes: DeployChange[];
  source: 'page' | 'setup';
  host_user: string | null;
  host: string | null;
  update_id: string | null;
  requested_by: string | null;
  log: string | null;
}

export async function listDeploys(tx: HelmTx, limit = 50): Promise<DeployEntry[]> {
  const rows = await tx<Row[]>`SELECT * FROM helm.helm_deploys(${limit})`;
  const ids = [...new Set(rows.map((r) => r.requested_by).filter((id): id is string => id !== null))];
  // Under RLS: somebody this tenant cannot see has no name here.
  const names = ids.length === 0
    ? new Map<string, string>()
    : new Map((await tx<{ id: string; name: string | null; email: string }[]>`
        SELECT id, name, email FROM app_user WHERE id = ANY (${ids}::uuid[])
      `).map((u) => [u.id, u.name ?? u.email]));

  return rows.map((row) => ({
    id: row.id,
    iteration: Number(row.iteration),
    deployedAt: row.deployed_at.toISOString(),
    commit: row.commit,
    previousCommit: row.previous_commit,
    title: row.title,
    changes: Array.isArray(row.changes) ? row.changes : [],
    source: row.source,
    requestedBy: row.requested_by ? names.get(row.requested_by) ?? null : null,
    hostUser: row.host_user,
    host: row.host,
    updateId: row.update_id,
    log: row.log,
  }));
}
