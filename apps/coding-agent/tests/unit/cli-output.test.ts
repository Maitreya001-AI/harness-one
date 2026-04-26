import { describe, expect, it } from 'vitest';

import {
  renderCheckpointList,
  renderJsonReport,
  renderResult,
} from '../../src/cli/output.js';
import type { TaskResult } from '../../src/agent/types.js';
import type { CheckpointSummary } from '../../src/memory/checkpoint.js';

const okResult: TaskResult = {
  taskId: 't1',
  state: 'done',
  summary: 'Rewrote parse.ts.',
  changedFiles: ['src/parse.ts'],
  cost: { usd: 0.0123, tokens: 4567 },
  iterations: 3,
  durationMs: 65_120,
  reason: 'completed',
};

describe('renderResult', () => {
  it('includes taskId, state, cost, and changed files', () => {
    const out = renderResult(okResult);
    expect(out).toContain('t1');
    expect(out).toContain('done');
    expect(out).toContain('completed');
    expect(out).toContain('src/parse.ts');
    expect(out).toMatch(/Cost: \$0\.0123/);
    expect(out).toMatch(/Iterations: 3/);
    expect(out).toMatch(/Duration: 1m05s/);
  });

  it('omits Changed-files header when none', () => {
    const out = renderResult({ ...okResult, changedFiles: [] });
    expect(out).not.toContain('Changed files');
  });

  it('renders error message when present', () => {
    const out = renderResult({ ...okResult, reason: 'error', errorMessage: 'boom' });
    expect(out).toContain('Error: boom');
  });

  it('formats sub-second durations as ms', () => {
    const out = renderResult({ ...okResult, durationMs: 250 });
    expect(out).toMatch(/Duration: 250ms/);
  });
});

describe('renderJsonReport', () => {
  it('emits valid JSON ending with newline', () => {
    const out = renderJsonReport(okResult);
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual(okResult);
  });
});

describe('renderCheckpointList', () => {
  it('returns empty notice when list is empty', () => {
    expect(renderCheckpointList([])).toContain('No checkpoints');
  });

  it('renders a tab-separated row per summary', () => {
    const summary: CheckpointSummary = {
      taskId: 't1',
      state: 'planning',
      iteration: 0,
      prompt: 'do thing',
      lastUpdatedAt: 0,
    };
    const out = renderCheckpointList([summary]);
    expect(out).toContain('t1');
    expect(out).toContain('planning');
    expect(out).toContain('do thing');
  });

  it('truncates long prompts', () => {
    const summary: CheckpointSummary = {
      taskId: 't',
      state: 'planning',
      iteration: 0,
      prompt: 'x'.repeat(200),
      lastUpdatedAt: 0,
    };
    const out = renderCheckpointList([summary]);
    expect(out).toContain('…');
  });
});
