/**
 * Is there a newer Helm on GitHub than the one running here?
 *
 * WHAT "THE ONE RUNNING HERE" IS. deploy/setup.sh passes the commit it is
 * building from into the image (HELM_BUILD_COMMIT, see the Dockerfile's runtime
 * stage). The image carries no .git — .dockerignore keeps the history out of
 * the build context — so without that build argument a running Helm has no way
 * to know which commit it is, and says so rather than guessing.
 *
 * WHAT IS ASKED. One request to GitHub's compare endpoint, this build's commit
 * against the tip of the branch deployments follow. It answers how far behind
 * this build is, the commits in between (so the notice can list the pull
 * requests that landed) and the files they touched (so it can say whether a
 * database migration is among them). The repository is public, so no token is
 * needed; HELM_UPDATE_GITHUB_TOKEN exists for a fork that is not.
 *
 * WHAT IS NOT DONE. Nothing here updates anything. Pulling and rebuilding needs
 * the Docker socket and the host's checkout, and the web tier holds neither on
 * purpose: a process holding decrypted credentials that could also rebuild and
 * restart itself from whatever a remote branch says is a much larger thing to
 * defend. The notice tells an administrator what to run.
 *
 * HELD IN MEMORY, PER PROCESS. A restart — which an update is — forgets the
 * answer, which is the right moment to forget it. Six hours between checks is
 * four requests a day, far inside GitHub's unauthenticated limit of 60 an hour.
 */

const DEFAULT_REPO = 'Soup9x/Lake-Effect-Helm';
const DEFAULT_BRANCH = 'main';
const DEFAULT_INSTALL_DIR = '/opt/lake-effect-helm';

/** How long a good answer is kept before GitHub is asked again. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** A failure is retried sooner, but not on every page load. */
const RETRY_AFTER_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 10_000;
/** The notice lists this many changes and links to GitHub for the rest. */
const MAX_CHANGES = 30;

export type UpdateState =
  /** HELM_UPDATE_CHECK=off. */
  | 'disabled'
  /** Built without HELM_BUILD_COMMIT, so there is nothing to compare. */
  | 'unknown_build'
  | 'up_to_date'
  | 'available'
  /** This build is newer than the branch — a feature branch, say. */
  | 'ahead'
  | 'error';

export interface UpdateChange {
  sha: string;
  title: string;
  /** The pull request number, when the commit says which one. */
  pr: number | null;
  url: string;
  date: string | null;
}

export interface UpdateStatus {
  state: UpdateState;
  repo: string;
  branch: string;
  current: { commit: string | null; date: string | null };
  latest: { commit: string; date: string | null } | null;
  /** Commits on the branch that this build does not have. */
  behindBy: number;
  /** Newest first, at most MAX_CHANGES. */
  changes: UpdateChange[];
  /** New files under db/sql — setup.sh applies them, but it is worth knowing. */
  migrations: number;
  compareUrl: string | null;
  checkedAt: string | null;
  error: string | null;
  /** Where the checkout lives on the host, for the commands the notice shows. */
  installDir: string;
}

export interface UpdateConfig {
  enabled: boolean;
  repo: string;
  branch: string;
  token: string | null;
  commit: string | null;
  installDir: string;
}

function readConfig(): UpdateConfig {
  const commit = (process.env.HELM_BUILD_COMMIT ?? '').trim().toLowerCase();
  const repo = (process.env.HELM_UPDATE_REPO ?? '').trim();
  return {
    enabled: !/^(off|false|0|no)$/i.test((process.env.HELM_UPDATE_CHECK ?? '').trim()),
    repo: /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : DEFAULT_REPO,
    branch: (process.env.HELM_UPDATE_BRANCH ?? '').trim() || DEFAULT_BRANCH,
    token: (process.env.HELM_UPDATE_GITHUB_TOKEN ?? '').trim() || null,
    commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : null,
    installDir: (process.env.HELM_INSTALL_DIR ?? '').trim() || DEFAULT_INSTALL_DIR,
  };
}

function baseStatus(config: UpdateConfig, state: UpdateState): UpdateStatus {
  return {
    state,
    repo: config.repo,
    branch: config.branch,
    current: { commit: config.commit, date: null },
    latest: null,
    behindBy: 0,
    changes: [],
    migrations: 0,
    compareUrl: null,
    checkedAt: null,
    error: null,
    installDir: config.installDir,
  };
}

// --- GitHub's compare response, the parts read ------------------------------

interface GitHubCommit {
  sha: string;
  html_url: string;
  commit: { message: string; committer?: { date?: string } | null; author?: { date?: string } | null };
}

export interface CompareResponse {
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  ahead_by: number;
  behind_by: number;
  html_url: string;
  base_commit: GitHubCommit;
  commits: GitHubCommit[];
  files?: { filename: string; status: string }[];
}

function commitDate(c: GitHubCommit): string | null {
  return c.commit.committer?.date ?? c.commit.author?.date ?? null;
}

const MERGE_PR = /^Merge pull request #(\d+) from \S+/;
const SQUASH_PR = /\(#(\d+)\)\s*$/;
const MERGE_OTHER = /^Merge (branch|remote-tracking branch|main|origin)\b/i;

/**
 * The commits between two builds, as the list a person wants to read.
 *
 * A merged pull request becomes one line titled with the PR's own title (the
 * merge commit carries it after a blank line). When the range has merges, the
 * commits inside them are the PR's working history and are left out, so the
 * list reads as "what landed" rather than every fix-up along the way. A range
 * of plain commits — no pull requests at all — is listed as it is.
 */
export function summariseCommits(commits: readonly GitHubCommit[]): UpdateChange[] {
  const hasMerges = commits.some((c) => MERGE_PR.test(c.commit.message));
  const out: UpdateChange[] = [];

  for (const c of commits) {
    const [subject = '', ...rest] = c.commit.message.split('\n');
    const merge = MERGE_PR.exec(subject);
    if (merge) {
      const body = rest.map((l) => l.trim()).find((l) => l.length > 0);
      out.push({ sha: c.sha, title: body ?? subject, pr: Number(merge[1]), url: c.html_url, date: commitDate(c) });
      continue;
    }
    const squash = SQUASH_PR.exec(subject);
    if (squash) {
      out.push({
        sha: c.sha, title: subject.replace(SQUASH_PR, '').trim(), pr: Number(squash[1]), url: c.html_url, date: commitDate(c),
      });
      continue;
    }
    if (hasMerges || MERGE_OTHER.test(subject)) continue;
    out.push({ sha: c.sha, title: subject.trim(), pr: null, url: c.html_url, date: commitDate(c) });
  }

  // GitHub lists oldest first; the notice reads newest first.
  return out.reverse();
}

/** Turn one compare response into a status. Separate from the fetch so it can be tested. */
export function statusFromCompare(config: UpdateConfig, body: CompareResponse, checkedAt: Date): UpdateStatus {
  const status = baseStatus(config, 'up_to_date');
  status.checkedAt = checkedAt.toISOString();
  status.compareUrl = body.html_url;
  status.current.date = commitDate(body.base_commit);

  const tip = body.commits.at(-1);
  status.latest = tip
    ? { commit: tip.sha, date: commitDate(tip) }
    : { commit: body.base_commit.sha, date: status.current.date };

  if (body.ahead_by > 0) {
    status.state = 'available';
    status.behindBy = body.ahead_by;
    status.changes = summariseCommits(body.commits).slice(0, MAX_CHANGES);
    status.migrations = (body.files ?? []).filter(
      (f) => f.status === 'added' && /^db\/sql\/\d+_[^/]+\.sql$/.test(f.filename),
    ).length;
  } else if (body.behind_by > 0) {
    status.state = 'ahead';
    status.latest = null;
  }
  return status;
}

async function fetchStatus(config: UpdateConfig): Promise<UpdateStatus> {
  const commit = config.commit!;
  const url = `https://api.github.com/repos/${config.repo}/compare/${commit}...${encodeURIComponent(config.branch)}`;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    // GitHub refuses API requests without one.
    'user-agent': 'Lake-Effect-Helm-update-check',
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  const failed = (message: string): UpdateStatus => ({
    ...baseStatus(config, 'error'),
    checkedAt: new Date().toISOString(),
    error: message,
  });

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
  } catch (error) {
    return failed(`Could not reach GitHub (${error instanceof Error ? error.message : String(error)}).`);
  }

  if (response.status === 404) {
    return failed(
      `GitHub does not know this build's commit (${commit.slice(0, 7)}) on ${config.repo}, or the repository is private. `
      + 'A build from a commit that was never pushed cannot be compared.',
    );
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    return failed('GitHub is rate-limiting this address. Helm will try again later.');
  }
  if (response.status === 401 || response.status === 403) {
    return failed(
      config.token
        ? `GitHub refused the token in HELM_UPDATE_GITHUB_TOKEN (${response.status}).`
        : `GitHub refused the request (${response.status}).`,
    );
  }
  if (!response.ok) return failed(`GitHub answered ${response.status}.`);

  try {
    return statusFromCompare(config, (await response.json()) as CompareResponse, new Date());
  } catch {
    return failed('GitHub answered with something Helm could not read.');
  }
}

// --- The cache ---------------------------------------------------------------

let cached: { status: UpdateStatus; at: number } | null = null;
let inflight: Promise<UpdateStatus> | null = null;

function fresh(entry: { status: UpdateStatus; at: number }): boolean {
  const ttl = entry.status.state === 'error' ? RETRY_AFTER_MS : CHECK_EVERY_MS;
  return Date.now() - entry.at < ttl;
}

/**
 * The current answer, asking GitHub only when the last answer is old (or when
 * `force` is set — the "Check now" button). Concurrent callers share one
 * request.
 */
export async function getUpdateStatus(options: { force?: boolean } = {}): Promise<UpdateStatus> {
  const config = readConfig();
  if (!config.enabled) return baseStatus(config, 'disabled');
  if (!config.commit) return baseStatus(config, 'unknown_build');

  if (!options.force && cached && fresh(cached)) return cached.status;
  inflight ??= fetchStatus(config)
    .then((status) => {
      cached = { status, at: Date.now() };
      return status;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Whatever is already known, without asking GitHub. For a badge on a page that should not wait. */
export function peekUpdateStatus(): UpdateStatus | null {
  const config = readConfig();
  if (!config.enabled) return baseStatus(config, 'disabled');
  if (!config.commit) return baseStatus(config, 'unknown_build');
  return cached?.status ?? null;
}

/** For tests. */
export function resetUpdateCache(): void {
  cached = null;
  inflight = null;
}

export { readConfig as readUpdateConfig };
