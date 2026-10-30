import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUpdateStatus, resetUpdateCache, statusFromCompare, summariseCommits,
  type CompareResponse, type UpdateConfig,
} from '../../src/lib/updates/check';

/**
 * The update check (src/lib/updates/check.ts): reading GitHub's compare
 * response into the notice an administrator sees, and when it asks at all.
 */

const config: UpdateConfig = {
  enabled: true,
  repo: 'Soup9x/Lake-Effect-Helm',
  branch: 'main',
  token: null,
  commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  installDir: '/opt/lake-effect-helm',
};

function commit(sha: string, message: string, date = '2026-10-29T12:00:00Z') {
  return { sha, html_url: `https://github.com/x/y/commit/${sha}`, commit: { message, committer: { date } } };
}

describe('summariseCommits', () => {
  it('lists merged pull requests by their titles, newest first, without their inner commits', () => {
    const changes = summariseCommits([
      commit('1', 'Add the thing'),
      commit('2', 'Fix the thing'),
      commit('3', 'Merge pull request #110 from Soup9x/claude/a\n\nDiagram editor upgrade'),
      commit('4', "Merge branch 'main' into claude/b"),
      commit('5', 'Merge pull request #111 from Soup9x/claude/b\n\nExtension 0.5.0'),
    ]);
    expect(changes.map((c) => [c.pr, c.title])).toEqual([
      [111, 'Extension 0.5.0'],
      [110, 'Diagram editor upgrade'],
    ]);
  });

  it('reads squash merges', () => {
    const [change] = summariseCommits([commit('1', 'Notify admins about updates (#112)')]);
    expect(change).toMatchObject({ pr: 112, title: 'Notify admins about updates' });
  });

  it('lists plain commits when there are no pull requests', () => {
    const changes = summariseCommits([commit('1', 'First\n\nbody'), commit('2', 'Second')]);
    expect(changes.map((c) => c.title)).toEqual(['Second', 'First']);
  });

  it('falls back to the merge subject when the PR title is missing', () => {
    const [change] = summariseCommits([commit('1', 'Merge pull request #9 from a/b')]);
    expect(change).toMatchObject({ pr: 9, title: 'Merge pull request #9 from a/b' });
  });
});

describe('statusFromCompare', () => {
  const base = commit(config.commit!, 'Old', '2026-10-20T00:00:00Z');
  const now = new Date('2026-10-30T00:00:00Z');

  it('reports an update with its changes and migrations', () => {
    const body: CompareResponse = {
      status: 'ahead', ahead_by: 2, behind_by: 0, html_url: 'https://github.com/compare',
      base_commit: base,
      commits: [commit('b1', 'One'), commit('b2', 'Two', '2026-10-29T18:00:00Z')],
      files: [
        { filename: 'db/sql/1210_new.sql', status: 'added' },
        { filename: 'db/sql/1200_old.sql', status: 'modified' },
        { filename: 'src/x.ts', status: 'added' },
      ],
    };
    const status = statusFromCompare(config, body, now);
    expect(status.state).toBe('available');
    expect(status.behindBy).toBe(2);
    expect(status.latest).toEqual({ commit: 'b2', date: '2026-10-29T18:00:00Z' });
    expect(status.current.date).toBe('2026-10-20T00:00:00Z');
    expect(status.migrations).toBe(1);
    expect(status.changes.map((c) => c.title)).toEqual(['Two', 'One']);
    expect(status.checkedAt).toBe(now.toISOString());
  });

  it('is up to date when identical', () => {
    const status = statusFromCompare(config, {
      status: 'identical', ahead_by: 0, behind_by: 0, html_url: '', base_commit: base, commits: [],
    }, now);
    expect(status.state).toBe('up_to_date');
    expect(status.latest?.commit).toBe(config.commit);
  });

  it('says a build newer than the branch has nothing to install', () => {
    const status = statusFromCompare(config, {
      status: 'behind', ahead_by: 0, behind_by: 3, html_url: '', base_commit: base, commits: [],
    }, now);
    expect(status.state).toBe('ahead');
    expect(status.latest).toBeNull();
  });
});

describe('getUpdateStatus', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetUpdateCache();
    process.env.HELM_BUILD_COMMIT = config.commit!;
    delete process.env.HELM_UPDATE_CHECK;
    delete process.env.HELM_UPDATE_GITHUB_TOKEN;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it('does not contact GitHub when turned off', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.HELM_UPDATE_CHECK = 'off';
    expect((await getUpdateStatus()).state).toBe('disabled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says it cannot tell without a recorded commit', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    delete process.env.HELM_BUILD_COMMIT;
    expect((await getUpdateStatus()).state).toBe('unknown_build');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks once, caches, and asks again when forced', async () => {
    const fetch = vi.fn(async () => Response.json({
      status: 'identical', ahead_by: 0, behind_by: 0, html_url: '',
      base_commit: commit(config.commit!, 'x'), commits: [],
    }));
    vi.stubGlobal('fetch', fetch);

    expect((await getUpdateStatus()).state).toBe('up_to_date');
    await getUpdateStatus();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/Soup9x/Lake-Effect-Helm/compare/${config.commit}...main`);
    expect((init.headers as Record<string, string>)['user-agent']).toBeTruthy();

    await getUpdateStatus({ force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('explains a commit GitHub does not know', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const status = await getUpdateStatus();
    expect(status.state).toBe('error');
    expect(status.error).toMatch(/does not know this build's commit/);
  });

  it('sends the token for a private fork', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    process.env.HELM_UPDATE_GITHUB_TOKEN = 'ghp_example';
    await getUpdateStatus();
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghp_example');
  });
});
