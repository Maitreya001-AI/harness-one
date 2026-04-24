import { describe, expect, it } from 'vitest';

import { defineSearchRecentIssuesTool } from '../../src/tools/search-recent-issues.js';
import type { GhRunner } from '../../src/github/gh-cli.js';

const NEVER_CALLED_GH: GhRunner = {
  async run() {
    throw new Error('gh runner should not have been invoked when fixedIssues is set');
  },
};

describe('defineSearchRecentIssuesTool', () => {
  it('uses fixedIssues without shelling out', async () => {
    const tool = defineSearchRecentIssuesTool({
      gh: NEVER_CALLED_GH,
      repository: 'a/b',
      fixedIssues: [
        {
          number: 1,
          title: 'adapter streaming regression',
          url: 'https://github.com/a/b/issues/1',
          state: 'closed',
          labels: ['bug'],
        },
      ],
    });
    const res = await tool.execute({ query: 'adapter streaming' });
    expect(res.kind).toBe('success');
    if (res.kind === 'success') {
      const data = res.data as { results: readonly { issueNumber: number }[] };
      expect(data.results).toEqual([expect.objectContaining({ issueNumber: 1 })]);
    }
  });

  it('clamps topK to [1,5]', async () => {
    const tool = defineSearchRecentIssuesTool({
      gh: NEVER_CALLED_GH,
      repository: 'a/b',
      fixedIssues: Array.from({ length: 10 }, (_, i) => ({
        number: i + 1,
        title: `adapter issue ${i + 1}`,
        url: `https://github.com/a/b/issues/${i + 1}`,
        state: 'closed' as const,
        labels: [] as string[],
      })),
    });
    const res = await tool.execute({ query: 'adapter', topK: 42 });
    if (res.kind === 'success') {
      const data = res.data as { results: readonly unknown[] };
      expect(data.results.length).toBeLessThanOrEqual(5);
    }
  });

  it('surfaces a tool error when gh invocation fails', async () => {
    const failingGh: GhRunner = {
      async run() {
        throw new Error('gh binary not found');
      },
    };
    const tool = defineSearchRecentIssuesTool({ gh: failingGh, repository: 'a/b' });
    const res = await tool.execute({ query: 'adapter' });
    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.message).toMatch(/gh binary not found/);
      expect(res.error.retryable).toBe(true);
    }
  });
});
