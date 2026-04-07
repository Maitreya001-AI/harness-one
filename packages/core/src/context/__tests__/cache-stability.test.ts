import { describe, it, expect } from 'vitest';
import { analyzeCacheStability } from '../cache-stability.js';
import type { Message } from '../../core/types.js';

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

describe('analyzeCacheStability', () => {
  it('returns perfect match for identical arrays', () => {
    const msgs = [msg('system', 'Sys'), msg('user', 'Hi')];
    const report = analyzeCacheStability(msgs, msgs);

    expect(report.prefixMatchRatio).toBe(1);
    expect(report.firstDivergenceIndex).toBe(-1);
    expect(report.stablePrefixTokens).toBeGreaterThan(0);
    expect(report.recommendations).toHaveLength(0);
  });

  it('detects divergence at a specific index', () => {
    const v1 = [msg('system', 'Sys'), msg('user', 'Hello')];
    const v2 = [msg('system', 'Sys'), msg('user', 'Hi there')];

    const report = analyzeCacheStability(v1, v2);
    expect(report.firstDivergenceIndex).toBe(1);
    expect(report.prefixMatchRatio).toBe(0.5);
    expect(report.stablePrefixTokens).toBeGreaterThan(0);
  });

  it('detects divergence at index 0 and recommends fixing system prompts', () => {
    const v1 = [msg('system', 'Version A')];
    const v2 = [msg('system', 'Version B')];

    const report = analyzeCacheStability(v1, v2);
    expect(report.firstDivergenceIndex).toBe(0);
    expect(report.stablePrefixTokens).toBe(0);
    expect(report.recommendations.some((r) => r.includes('system prompts'))).toBe(true);
  });

  it('handles different length arrays', () => {
    const v1 = [msg('system', 'Sys'), msg('user', 'Hi')];
    const v2 = [msg('system', 'Sys'), msg('user', 'Hi'), msg('assistant', 'Hello')];

    const report = analyzeCacheStability(v1, v2);
    expect(report.firstDivergenceIndex).toBe(2); // diverges at the extra message
    expect(report.prefixMatchRatio).toBeCloseTo(2 / 3, 2);
  });

  it('handles empty arrays', () => {
    const report = analyzeCacheStability([], []);
    expect(report.prefixMatchRatio).toBe(1);
    expect(report.firstDivergenceIndex).toBe(-1);
    expect(report.stablePrefixTokens).toBe(0);
  });

  it('handles one empty array', () => {
    const report = analyzeCacheStability([], [msg('user', 'Hi')]);
    expect(report.firstDivergenceIndex).toBe(0);
    expect(report.prefixMatchRatio).toBe(0);
  });

  it('generates recommendation for moderate stability', () => {
    const base = [msg('system', 'Sys'), msg('user', 'A'), msg('assistant', 'B')];
    const v2 = [msg('system', 'Sys'), msg('user', 'A'), msg('assistant', 'C'), msg('user', 'D')];

    const report = analyzeCacheStability(base, v2);
    expect(report.prefixMatchRatio).toBe(0.5);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});
