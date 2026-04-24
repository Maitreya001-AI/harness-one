import { describe, expect, it } from 'vitest';

import { rankByOverlap, type RecentIssue } from '../../src/github/search-recent.js';

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
