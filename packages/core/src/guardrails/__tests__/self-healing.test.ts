import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSelfHealing } from '../self-healing.js';
import type { Guardrail } from '../types.js';

describe('withSelfHealing', () => {
  it('passes on first try when all guardrails allow', async () => {
    const guard: Guardrail = () => ({ action: 'allow' });
    const regenerate = vi.fn();
    const result = await withSelfHealing(
      {
        guardrails: [{ name: 'g1', guard }],
        buildRetryPrompt: () => '',
        regenerate,
      },
      'good content',
    );
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.content).toBe('good content');
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('retries and passes on second attempt', async () => {
    let callCount = 0;
    const guard: Guardrail = () => {
      callCount++;
      if (callCount === 1) return { action: 'block', reason: 'bad' };
      return { action: 'allow' };
    };
    const regenerate = vi.fn().mockResolvedValue('fixed content');
    const buildRetryPrompt = vi.fn().mockReturnValue('fix it');

    const result = await withSelfHealing(
      {
        guardrails: [{ name: 'g1', guard }],
        buildRetryPrompt,
        regenerate,
      },
      'bad content',
    );

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.content).toBe('fixed content');
    expect(buildRetryPrompt).toHaveBeenCalledWith('bad content', [{ reason: 'bad' }]);
    expect(regenerate).toHaveBeenCalledWith('fix it');
  });

  it('fails after maxRetries exceeded', async () => {
    const guard: Guardrail = () => ({ action: 'block', reason: 'always bad' });
    const regenerate = vi.fn().mockResolvedValue('still bad');

    const result = await withSelfHealing(
      {
        maxRetries: 2,
        guardrails: [{ name: 'g1', guard }],
        buildRetryPrompt: () => 'fix it',
        regenerate,
      },
      'bad content',
    );

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    // regenerate called once (after first fail, before second attempt)
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it('collects failures from multiple guardrails', async () => {
    let callCount = 0;
    const guard1: Guardrail = () => {
      callCount++;
      if (callCount <= 2) return { action: 'block', reason: 'reason1' };
      return { action: 'allow' };
    };
    const guard2: Guardrail = () => {
      if (callCount <= 2) return { action: 'block', reason: 'reason2' };
      return { action: 'allow' };
    };
    const buildRetryPrompt = vi.fn().mockReturnValue('fix both');
    const regenerate = vi.fn().mockResolvedValue('better');

    const result = await withSelfHealing(
      {
        maxRetries: 3,
        guardrails: [
          { name: 'g1', guard: guard1 },
          { name: 'g2', guard: guard2 },
        ],
        buildRetryPrompt,
        regenerate,
      },
      'initial',
    );

    expect(result.passed).toBe(true);
    // First call should have both failures
    expect(buildRetryPrompt).toHaveBeenCalledWith('initial', [
      { reason: 'reason1' },
      { reason: 'reason2' },
    ]);
  });

  it('defaults maxRetries to 3', async () => {
    const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
    const regenerate = vi.fn().mockResolvedValue('still bad');

    const result = await withSelfHealing(
      {
        guardrails: [{ name: 'g1', guard }],
        buildRetryPrompt: () => 'fix',
        regenerate,
      },
      'bad',
    );

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(3);
    // regenerate called twice (after attempt 1 and 2, attempt 3 is the last check)
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  describe('H3: exponential backoff', () => {
    it('applies exponential backoff delay between retries', async () => {
      const timestamps: number[] = [];
      const guard: Guardrail = () => {
        timestamps.push(Date.now());
        return { action: 'block', reason: 'bad' };
      };
      const regenerate = vi.fn().mockResolvedValue('still bad');

      const result = await withSelfHealing(
        {
          maxRetries: 3,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
        },
        'bad',
      );

      expect(result.passed).toBe(false);
      expect(timestamps.length).toBe(3);

      // Verify delays: first->second should be >= 1000ms (2^0 * 1000)
      const delay1 = timestamps[1] - timestamps[0];
      expect(delay1).toBeGreaterThanOrEqual(950); // allow small timing tolerance

      // second->third should be >= 2000ms (2^1 * 1000)
      const delay2 = timestamps[2] - timestamps[1];
      expect(delay2).toBeGreaterThanOrEqual(1950); // allow small timing tolerance
    }, 10_000);
  });

  describe('H4: regenerate timeout', () => {
    it('fails when regenerate exceeds timeout', async () => {
      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 60_000)),
      );

      const result = await withSelfHealing(
        {
          maxRetries: 2,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
          regenerateTimeoutMs: 50,
        },
        'bad',
      );

      // Should have failed because regenerate timed out
      expect(result.passed).toBe(false);
    });

    it('succeeds when regenerate completes within timeout', async () => {
      let callCount = 0;
      const guard: Guardrail = () => {
        callCount++;
        if (callCount === 1) return { action: 'block', reason: 'bad' };
        return { action: 'allow' };
      };
      const regenerate = vi.fn().mockResolvedValue('fixed');

      const result = await withSelfHealing(
        {
          maxRetries: 2,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
          regenerateTimeoutMs: 5000,
        },
        'bad',
      );

      expect(result.passed).toBe(true);
    });
  });

  it('treats modify verdict as a failure for retry', async () => {
    let callCount = 0;
    const guard: Guardrail = () => {
      callCount++;
      if (callCount === 1) return { action: 'modify', modified: 'x', reason: 'needs fix' };
      return { action: 'allow' };
    };
    const regenerate = vi.fn().mockResolvedValue('fixed');

    const result = await withSelfHealing(
      {
        guardrails: [{ name: 'g1', guard }],
        buildRetryPrompt: () => 'fix',
        regenerate,
      },
      'original',
    );

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(2);
  });
});
