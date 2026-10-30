/**
 * Updates installed from the Updates page (1210).
 *
 * The page writes a request; deploy/updater.sh on the host picks it up within a
 * minute, pulls the commit and runs deploy/setup.sh --yes, and writes back how
 * it went. Every function here goes through a SECURITY DEFINER function that
 * requires tenant:write — the tables themselves are closed to helm_app.
 */
import type { HelmTx } from '../db/client';

export type UpdateRequestStatus = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface UpdateRequest {
  id: string;
  status: UpdateRequestStatus;
  targetCommit: string;
  scheduledFor: string;
  requestedAt: string;
  requestedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  fromCommit: string | null;
  toCommit: string | null;
  stage: string | null;
  log: string | null;
  error: string | null;
}

export interface UpdaterState {
  /** The host updater checked in recently, so a request will be picked up. */
  installed: boolean;
  lastSeenAt: string | null;
}

/**
 * The timer fires every minute. Three minutes of silence means it is not
 * there (never installed, turned off in setup.sh, or the host is down) — and
 * a request then would wait for nothing.
 */
const UPDATER_STALE_MS = 3 * 60 * 1000;

interface Row {
  id: string;
  status: UpdateRequestStatus;
  target_commit: string;
  scheduled_for: Date;
  requested_at: Date;
  requested_by: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  from_commit: string | null;
  to_commit: string | null;
  stage: string | null;
  log: string | null;
  error: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toRequest(row: Row, names: Map<string, string>): UpdateRequest {
  return {
    id: row.id,
    status: row.status,
    targetCommit: row.target_commit,
    scheduledFor: row.scheduled_for.toISOString(),
    requestedAt: row.requested_at.toISOString(),
    requestedBy: row.requested_by ? names.get(row.requested_by) ?? null : null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    fromCommit: row.from_commit,
    toCommit: row.to_commit,
    stage: row.stage,
    log: row.log,
    error: row.error,
  };
}

async function namesFor(tx: HelmTx, rows: readonly Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.requested_by).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  // Under RLS: a person this tenant cannot see simply has no name here.
  const found = await tx<{ id: string; name: string | null; email: string }[]>`
    SELECT id, name, email FROM app_user WHERE id = ANY (${ids}::uuid[])
  `;
  return new Map(found.map((u) => [u.id, u.name ?? u.email]));
}

export async function listUpdateRequests(tx: HelmTx, limit = 10): Promise<UpdateRequest[]> {
  const rows = await tx<Row[]>`SELECT * FROM helm.helm_updates(${limit})`;
  const names = await namesFor(tx, rows);
  return rows.map((row) => toRequest(row, names));
}

export async function readUpdater(tx: HelmTx): Promise<UpdaterState> {
  const [row] = await tx<{ seen: Date | null }[]>`SELECT helm.helm_updater_last_seen() AS seen`;
  const seen = row?.seen ?? null;
  return {
    installed: seen !== null && Date.now() - seen.getTime() < UPDATER_STALE_MS,
    lastSeenAt: iso(seen),
  };
}

export async function requestUpdate(tx: HelmTx, target: string, at: Date | null): Promise<UpdateRequest> {
  const [row] = await tx<Row[]>`
    SELECT * FROM helm.request_helm_update(${target}, ${at}::timestamptz)
  `;
  return toRequest(row!, await namesFor(tx, [row!]));
}

export async function cancelUpdate(tx: HelmTx, id: string): Promise<UpdateRequest> {
  const [row] = await tx<Row[]>`SELECT * FROM helm.cancel_helm_update(${id}::uuid)`;
  return toRequest(row!, await namesFor(tx, [row!]));
}

/** The one queued or running, if any — the banner and the page lead with it. */
export function openRequest(requests: readonly UpdateRequest[]): UpdateRequest | null {
  return requests.find((r) => r.status === 'scheduled' || r.status === 'running') ?? null;
}
