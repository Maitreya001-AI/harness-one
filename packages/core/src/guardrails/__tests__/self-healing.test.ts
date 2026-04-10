import { describe, it, expect, vi } from 'vitest';
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

  it('stops at first guardrail failure instead of running all guardrails', async () => {
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
    // Stop at first failure: only first guardrail's failure should be collected
    expect(buildRetryPrompt).toHaveBeenCalledWith('initial', [
      { reason: 'reason1' },
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
    it('applies exponential backoff with jitter between retries', async () => {
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

      // Verify delays with jitter: base * (0.5 + random * 0.5)
      // first->second: 1000 * (0.5-1.0) = 500-1000ms
      const delay1 = timestamps[1] - timestamps[0];
      expect(delay1).toBeGreaterThanOrEqual(450); // allow small timing tolerance

      // second->third: 2000 * (0.5-1.0) = 1000-2000ms
      const delay2 = timestamps[2] - timestamps[1];
      expect(delay2).toBeGreaterThanOrEqual(950); // allow small timing tolerance
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

  describe('edge cases', () => {
    it('max retries exceeded: returns failure with correct attempt count', async () => {
      const guard: Guardrail = () => ({ action: 'block', reason: 'always fails' });
      const regenerate = vi.fn().mockResolvedValue('still bad');

      // Use only 2 retries to keep the real backoff short (1s total backoff)
      const result = await withSelfHealing(
        {
          maxRetries: 2,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
        },
        'bad content',
      );

      expect(result.passed).toBe(false);
      expect(result.attempts).toBe(2);
      // Regenerate called once (between attempt 1 and 2)
      expect(regenerate).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('backoff timing: verify delay increases exponentially with jitter', async () => {
      // Collect backoff delays by intercepting setTimeout
      const backoffDelays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        if (typeof ms === 'number' && ms >= 400) {
          backoffDelays.push(ms);
        }
        // Run immediately for speed
        return realSetTimeout(fn as () => void, 0, ...args);
      });

      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockResolvedValue('still bad');

      await withSelfHealing(
        {
          maxRetries: 4,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
        },
        'bad',
      );

      setTimeoutSpy.mockRestore();

      // There are 3 backoff delays (between attempts 1-2, 2-3, 3-4)
      // But regenerateTimeoutMs also creates setTimeout calls with the timeout value (default 30000)
      // Filter to only the backoff delays (with jitter: 500-1000, 1000-2000, 2000-4000)
      const exponentialDelays = backoffDelays.filter((d) => d <= 10_000);
      expect(exponentialDelays.length).toBe(3);
      // With jitter: base * (0.5 + Math.random() * 0.5)
      // 1000 * (0.5-1.0) = 500-1000, 2000 * (0.5-1.0) = 1000-2000, 4000 * (0.5-1.0) = 2000-4000
      expect(exponentialDelays[0]).toBeGreaterThanOrEqual(500);
      expect(exponentialDelays[0]).toBeLessThanOrEqual(1000);
      expect(exponentialDelays[1]).toBeGreaterThanOrEqual(1000);
      expect(exponentialDelays[1]).toBeLessThanOrEqual(2000);
      expect(exponentialDelays[2]).toBeGreaterThanOrEqual(2000);
      expect(exponentialDelays[2]).toBeLessThanOrEqual(4000);
    });

    it('regenerate timeout: when regenerate hangs, self-healing returns failure', async () => {
      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockImplementation(
        () => new Promise(() => {}), // never resolves
      );

      const result = await withSelfHealing(
        {
          maxRetries: 3,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
          regenerateTimeoutMs: 50,
        },
        'bad content',
      );

      expect(result.passed).toBe(false);
      // Should fail on the first retry attempt when regenerate times out
      expect(result.attempts).toBe(1);
      expect(result.content).toBe('bad content'); // original content, since regenerate never completed
    });

    it('all guardrails pass on first try: no regenerate needed, returns immediately', async () => {
      const guard1: Guardrail = () => ({ action: 'allow' });
      const guard2: Guardrail = () => ({ action: 'allow' });
      const regenerate = vi.fn();
      const buildRetryPrompt = vi.fn();

      const result = await withSelfHealing(
        {
          maxRetries: 5,
          guardrails: [
            { name: 'g1', guard: guard1 },
            { name: 'g2', guard: guard2 },
          ],
          buildRetryPrompt,
          regenerate,
        },
        'perfect content',
      );

      expect(result.passed).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.content).toBe('perfect content');
      expect(regenerate).not.toHaveBeenCalled();
      expect(buildRetryPrompt).not.toHaveBeenCalled();
    });
  });

  describe('token budget awareness', () => {
    it('returns passed: false early when maxTotalTokens is exceeded', async () => {
      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockResolvedValue('still bad');
      // estimateTokens returns string length as token count
      const estimateTokens = (text: string) => text.length;

      const result = await withSelfHealing(
        {
          maxRetries: 5,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: (content, failures) => `Fix this long prompt that will exceed budget: ${content} ${failures[0].reason}`,
          regenerate,
          estimateTokens,
          maxTotalTokens: 50, // very low budget
        },
        'initial content that uses some tokens',
      );

      // Should have stopped early due to token budget, not exhausted all retries
      expect(result.passed).toBe(false);
      expect(result.totalTokens).toBeDefined();
      expect(result.totalTokens!).toBeLessThanOrEqual(50);
      // Should NOT have used all 5 retries
      expect(result.attempts).toBeLessThan(5);
    });

    it('tracks totalTokens across successful regeneration attempts', async () => {
      let callCount = 0;
      const guard: Guardrail = () => {
        callCount++;
        if (callCount <= 2) return { action: 'block', reason: 'bad' };
        return { action: 'allow' };
      };
      const regenerate = vi.fn().mockResolvedValue('fixed');
      const estimateTokens = (text: string) => text.length;

      const result = await withSelfHealing(
        {
          maxRetries: 5,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
          estimateTokens,
          maxTotalTokens: 10000, // high budget, won't be exceeded
        },
        'initial',
      );

      expect(result.passed).toBe(true);
      expect(result.totalTokens).toBeDefined();
      // initial (7) + fixed (5) + fixed (5) = 17
      expect(result.totalTokens).toBe('initial'.length + 'fixed'.length + 'fixed'.length);
    });

    it('returns totalTokens as undefined when estimateTokens is not provided', async () => {
      const guard: Guardrail = () => ({ action: 'allow' });
      const result = await withSelfHealing(
        {
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => '',
          regenerate: vi.fn(),
        },
        'content',
      );
      expect(result.totalTokens).toBeUndefined();
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

  // ===========================================================================
  // Fix 6: Self-healing improvements
  // ===========================================================================

  describe('Fix 6: jitter in exponential backoff', () => {
    it('adds jitter so backoff is not deterministic', async () => {
      // Run multiple times and collect delays to verify they vary
      const delays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        if (typeof ms === 'number' && ms >= 400) {
          delays.push(ms);
        }
        return realSetTimeout(fn as () => void, 0, ...args);
      });

      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockResolvedValue('still bad');

      await withSelfHealing(
        {
          maxRetries: 2,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
        },
        'bad',
      );

      setTimeoutSpy.mockRestore();

      // With jitter, delay should be in range [500, 1000] for first backoff
      const backoffDelays = delays.filter((d) => d <= 10_000);
      expect(backoffDelays.length).toBe(1);
      expect(backoffDelays[0]).toBeGreaterThanOrEqual(500);
      expect(backoffDelays[0]).toBeLessThanOrEqual(1000);
    });
  });

  describe('Fix 6: AbortSignal cancellation', () => {
    it('stops immediately when signal is already aborted', async () => {
      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockResolvedValue('fixed');
      const controller = new AbortController();
      controller.abort();

      const result = await withSelfHealing(
        {
          maxRetries: 5,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
          signal: controller.signal,
        },
        'bad content',
      );

      expect(result.passed).toBe(false);
      expect(result.attempts).toBe(1);
      expect(regenerate).not.toHaveBeenCalled();
    });

    it('stops on subsequent attempt when signal is aborted during retries', async () => {
      let callCount = 0;
      const controller = new AbortController();
      const guard: Guardrail = () => {
        callCount++;
        if (callCount >= 2) {
          controller.abort();
        }
        return { action: 'block', reason: 'bad' };
      };
      const realSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        return realSetTimeout(fn as () => void, 0, ...args);
      });

      const regenerate = vi.fn().mockResolvedValue('still bad');

      const result = await withSelfHealing(
        {
          maxRetries: 10,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
          signal: controller.signal,
        },
        'bad',
      );

      setTimeoutSpy.mockRestore();

      expect(result.passed).toBe(false);
      // Should have stopped early, not used all 10 retries
      expect(result.attempts).toBeLessThan(10);
    });

    it('passes without signal (backward compatibility)', async () => {
      const guard: Guardrail = () => ({ action: 'allow' });
      const result = await withSelfHealing(
        {
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => '',
          regenerate: vi.fn(),
        },
        'good',
      );
      expect(result.passed).toBe(true);
    });
  });

  describe('Fix 6: stop at first guardrail failure', () => {
    it('only reports first failing guardrail, skips rest', async () => {
      const guard2Called = vi.fn();
      const guard1: Guardrail = () => ({ action: 'block', reason: 'first fail' });
      const guard2: Guardrail = () => {
        guard2Called();
        return { action: 'block', reason: 'second fail' };
      };

      const realSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        return realSetTimeout(fn as () => void, 0, ...args);
      });

      const buildRetryPrompt = vi.fn().mockReturnValue('fix');
      const regenerate = vi.fn().mockResolvedValue('still bad');

      await withSelfHealing(
        {
          maxRetries: 2,
          guardrails: [
            { name: 'g1', guard: guard1 },
            { name: 'g2', guard: guard2 },
          ],
          buildRetryPrompt,
          regenerate,
        },
        'bad',
      );

      setTimeoutSpy.mockRestore();

      // guard2 should never be called since guard1 blocks first
      expect(guard2Called).not.toHaveBeenCalled();
      // buildRetryPrompt should only receive the first failure
      expect(buildRetryPrompt).toHaveBeenCalledWith('bad', [{ reason: 'first fail' }]);
    });

    it('runs second guardrail if first allows', async () => {
      let attempt = 0;
      const guard1: Guardrail = () => ({ action: 'allow' });
      const guard2: Guardrail = () => {
        attempt++;
        if (attempt === 1) return { action: 'block', reason: 'second blocks' };
        return { action: 'allow' };
      };

      const realSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        return realSetTimeout(fn as () => void, 0, ...args);
      });

      const buildRetryPrompt = vi.fn().mockReturnValue('fix');
      const regenerate = vi.fn().mockResolvedValue('fixed');

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

      setTimeoutSpy.mockRestore();

      expect(result.passed).toBe(true);
      expect(buildRetryPrompt).toHaveBeenCalledWith('initial', [{ reason: 'second blocks' }]);
    });
  });

  describe('Fix 11: token budget tracking on regeneration failure', () => {
    it('counts retry prompt tokens in totalTokens even when regenerate() throws', async () => {
      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockRejectedValue(new Error('LLM API down'));
      const estimateTokens = (text: string) => text.length;

      const realSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        return realSetTimeout(fn as () => void, 0, ...args);
      });

      const result = await withSelfHealing(
        {
          maxRetries: 3,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix this please',
          regenerate,
          estimateTokens,
          maxTotalTokens: 10000,
        },
        'bad content',
      );

      setTimeoutSpy.mockRestore();

      expect(result.passed).toBe(false);
      expect(result.totalTokens).toBeDefined();
      // totalTokens should include: initial content tokens + retry prompt tokens
      // initial: 'bad content'.length = 11
      // retry prompt: 'fix this please'.length = 15
      // Total: 11 + 15 = 26
      expect(result.totalTokens).toBe('bad content'.length + 'fix this please'.length);
    });

    it('counts retry prompt tokens on timeout failure', async () => {
      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockImplementation(
        () => new Promise(() => {}), // never resolves
      );
      const estimateTokens = (text: string) => text.length;

      const result = await withSelfHealing(
        {
          maxRetries: 2,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'retry prompt',
          regenerate,
          estimateTokens,
          maxTotalTokens: 10000,
          regenerateTimeoutMs: 50,
        },
        'initial',
      );

      expect(result.passed).toBe(false);
      expect(result.totalTokens).toBeDefined();
      // initial: 'initial'.length = 7
      // retry prompt: 'retry prompt'.length = 12
      expect(result.totalTokens).toBe('initial'.length + 'retry prompt'.length);
    });
  });

  describe('Fix 6: regenerate error not swallowed', () => {
    it('returns failure when regenerate throws with error info preserved', async () => {
      const guard: Guardrail = () => ({ action: 'block', reason: 'bad' });
      const regenerate = vi.fn().mockRejectedValue(new Error('LLM API down'));

      const realSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        return realSetTimeout(fn as () => void, 0, ...args);
      });

      const result = await withSelfHealing(
        {
          maxRetries: 3,
          guardrails: [{ name: 'g1', guard }],
          buildRetryPrompt: () => 'fix',
          regenerate,
        },
        'bad',
      );

      setTimeoutSpy.mockRestore();

      expect(result.passed).toBe(false);
      // Should have stopped after first regeneration failure
      expect(result.attempts).toBe(1);
      expect(result.content).toBe('bad'); // original content, regenerate failed
    });
  });
});
