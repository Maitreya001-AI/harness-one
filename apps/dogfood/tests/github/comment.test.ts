import { describe, expect, it } from 'vitest';

import { applyLabels, postIssueComment } from '../../src/github/comment.js';
import type { GhResult, GhRunner } from '../../src/github/gh-cli.js';

interface Invocation {
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

function makeRecordingGh(result: GhResult): { readonly gh: GhRunner; readonly calls: Invocation[] } {
  const calls: Invocation[] = [];
  const gh: GhRunner = {
    async run(args, options) {
      calls.push({ args: [...args], stdin: options?.stdin });
      return result;
    },
  };
  return { gh, calls };
}

describe('postIssueComment', () => {
  it('invokes `gh issue comment -F -` and pipes body through stdin (no shell interpolation)', async () => {
    const { gh, calls } = makeRecordingGh({ stdout: '', stderr: '', exitCode: 0 });
    const body = 'hello `whoami` $(id) — the body must not be shell-interpreted';
    await postIssueComment(gh, { repository: 'owner/repo', issueNumber: 42, body });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      'issue',
      'comment',
      '42',
      '--repo',
      'owner/repo',
      '-F',
      '-',
    ]);
    expect(calls[0]!.stdin).toBe(body);
  });

  it('throws an Error carrying exitCode and stderr when gh fails', async () => {
    const { gh } = makeRecordingGh({ stdout: '', stderr: 'HTTP 403: forbidden\n', exitCode: 1 });
    await expect(
      postIssueComment(gh, { repository: 'owner/repo', issueNumber: 7, body: 'x' }),
    ).rejects.toThrow(/gh issue comment exited 1: HTTP 403: forbidden/);
  });
});

describe('applyLabels', () => {
  it('no-ops without invoking gh when labels is empty', async () => {
    const { gh, calls } = makeRecordingGh({ stdout: '', stderr: '', exitCode: 0 });
    await applyLabels(gh, { repository: 'owner/repo', issueNumber: 1, labels: [] });
    expect(calls).toHaveLength(0);
  });

  it('passes one --add-label per label so partial failures stay visible in the workflow log', async () => {
    const { gh, calls } = makeRecordingGh({ stdout: '', stderr: '', exitCode: 0 });
    await applyLabels(gh, {
      repository: 'owner/repo',
      issueNumber: 42,
      labels: ['bug', 'triaged', 'needs-repro'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      'issue',
      'edit',
      '42',
      '--repo',
      'owner/repo',
      '--add-label',
      'bug',
      '--add-label',
      'triaged',
      '--add-label',
      'needs-repro',
    ]);
  });

  it('throws an Error carrying exitCode and stderr when gh fails', async () => {
    const { gh } = makeRecordingGh({ stdout: '', stderr: 'label `bogus` not found\n', exitCode: 2 });
    await expect(
      applyLabels(gh, { repository: 'owner/repo', issueNumber: 9, labels: ['bogus'] }),
    ).rejects.toThrow(/gh issue edit exited 2: label `bogus` not found/);
  });
});
