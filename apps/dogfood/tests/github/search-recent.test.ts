import { describe, expect, it } from 'vitest';

import { listRecentIssues, rankByOverlap, type RecentIssue } from '../../src/github/search-recent.js';
import type { GhResult, GhRunner } from '../../src/github/gh-cli.js';

interface Invocation {
  readonly args: readonly string[];
}

function makeRecordingGh(result: GhResult): { readonly gh: GhRunner; readonly calls: Invocation[] } {
  const calls: Invocation[] = [];
  const gh: GhRunner = {
    async run(args) {
      calls.push({ args: [...args] });
      return result;
    },
  };
  return { gh, calls };
}

const ISSUES: readonly RecentIssue[] = [
  {
    number: 1,
    title: 'Anthropic adapter streaming aborts',
    url: 'https://github.com/a/b/issues/1',
    state: 'closed',
    labels: ['bug', 'adapter'],
  },
  {
    number: 2,
    title: 'Guardrail pipeline throws on empty input',
    url: 'https://github.com/a/b/issues/2',
    state: 'closed',
    labels: ['guardrails'],
  },
  {
    number: 3,
    title: 'Memory leak in FileSystemStore under load',
    url: 'https://github.com/a/b/issues/3',
    state: 'closed',
    labels: ['memory'],
  },
];

describe('rankByOverlap', () => {
  it('returns only issues with overlapping tokens, sorted by score', () => {
    const ranked = rankByOverlap(ISSUES, 'anthropic adapter streaming');
    expect(ranked.map((i) => i.number)).toEqual([1]);
  });

  it('returns up to topK results', () => {
    const ranked = rankByOverlap(ISSUES, 'adapter guardrail memory', 2);
    expect(ranked.length).toBeLessThanOrEqual(2);
  });

  it('falls back to empty when no token overlaps', () => {
    const ranked = rankByOverlap(ISSUES, 'unrelated vocabulary only');
    expect(ranked).toEqual([]);
  });

  it('ignores tokens shorter than 3 chars to reduce noise', () => {
    const ranked = rankByOverlap(ISSUES, 'a b c d');
    expect(ranked).toEqual([]);
  });
});

describe('listRecentIssues', () => {
  it('invokes `gh issue list --json` with default limit=100 / state=closed and normalizes the payload', async () => {
    const payload = JSON.stringify([
      {
        number: 42,
        title: 'streaming aborts',
        url: 'https://github.com/a/b/issues/42',
        state: 'CLOSED',
        labels: [{ name: 'bug' }, { name: 'adapter' }],
      },
    ]);
    const { gh, calls } = makeRecordingGh({ stdout: payload, stderr: '', exitCode: 0 });
    const issues = await listRecentIssues(gh, { repository: 'a/b' });
    expect(calls[0]!.args).toEqual([
      'issue',
      'list',
      '--repo',
      'a/b',
      '--state',
      'closed',
      '--limit',
      '100',
      '--json',
      'number,title,url,state,labels',
    ]);
    expect(issues).toEqual([
      {
        number: 42,
        title: 'streaming aborts',
        url: 'https://github.com/a/b/issues/42',
        state: 'closed',
        labels: ['bug', 'adapter'],
      },
    ]);
  });

  it('forwards explicit limit and state to the gh invocation', async () => {
    const { gh, calls } = makeRecordingGh({ stdout: '[]', stderr: '', exitCode: 0 });
    await listRecentIssues(gh, { repository: 'a/b', limit: 5, state: 'open' });
    expect(calls[0]!.args).toEqual([
      'issue',
      'list',
      '--repo',
      'a/b',
      '--state',
      'open',
      '--limit',
      '5',
      '--json',
      'number,title,url,state,labels',
    ]);
  });

  it('throws with exitCode and stderr when gh fails', async () => {
    const { gh } = makeRecordingGh({ stdout: '', stderr: 'rate limited\n', exitCode: 4 });
    await expect(listRecentIssues(gh, { repository: 'a/b' })).rejects.toThrow(
      /gh issue list exited 4: rate limited/,
    );
  });

  it('returns [] on empty stdout (gh sometimes emits nothing on empty result sets)', async () => {
    const { gh } = makeRecordingGh({ stdout: '   \n', stderr: '', exitCode: 0 });
    await expect(listRecentIssues(gh, { repository: 'a/b' })).resolves.toEqual([]);
  });

  it('returns [] when gh returns a non-array JSON value (defensive against schema drift)', async () => {
    const { gh } = makeRecordingGh({ stdout: '{"oops": "not an array"}', stderr: '', exitCode: 0 });
    await expect(listRecentIssues(gh, { repository: 'a/b' })).resolves.toEqual([]);
  });

  it('normalizes malformed entries with safe fallbacks (no throw on missing or wrong-typed fields)', async () => {
    const payload = JSON.stringify([
      { number: 1 }, // missing everything else
      { number: 'not-a-number', title: 42, url: null, state: 'UNKNOWN', labels: 'not-an-array' },
      { number: 2, title: 't', url: 'u', state: 'open', labels: [{ wrong: 'shape' }, { name: 'ok' }] },
    ]);
    const { gh } = makeRecordingGh({ stdout: payload, stderr: '', exitCode: 0 });
    const issues = await listRecentIssues(gh, { repository: 'a/b' });
    expect(issues).toEqual([
      { number: 1, title: '', url: '', state: 'closed', labels: [] },
      { number: 0, title: '', url: '', state: 'closed', labels: [] },
      { number: 2, title: 't', url: 'u', state: 'open', labels: ['ok'] },
    ]);
  });
});
