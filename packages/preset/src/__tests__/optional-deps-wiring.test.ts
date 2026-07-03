/**
 * Integration tests for lazy optional-peer wiring in `createHarness`.
 *
 * Verifies the decoupling contract added when `@harness-one/anthropic`,
 * `@harness-one/openai`, and `@harness-one/devkit` became OPTIONAL peers:
 *
 * 1. Selecting a provider loads ONLY that provider's adapter package.
 * 2. A missing selected-provider package surfaces an actionable HarnessError.
 * 3. `harness.eval` never loads `@harness-one/devkit` until a method is called
 *    (graceful degradation), then memoizes the runner.
 * 4. Calling `harness.eval` when devkit is absent throws an actionable error.
 *
 * The `optional-dep` seam is mocked so we can observe which packages are
 * requested and toggle their availability — `createRequire` (the real seam)
 * bypasses vitest's module system, so we intercept at the preset-internal seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { HarnessError, HarnessErrorCode } from 'harness-one/core';

const seam = vi.hoisted(() => {
  const requested: string[] = [];
  const available = new Set<string>();
  return { requested, available };
});

vi.mock('../build-harness/optional-dep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../build-harness/optional-dep.js')>();

  const fakeAdapter = (name: string) => ({
    name,
    chat: vi.fn(async () => ({
      message: { role: 'assistant', content: 'ok' },
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
  });
  const fakeRunner = {
    run: vi.fn(async () => ({ passed: true })),
    runSingle: vi.fn(async () => ({ score: 1 })),
    checkGate: vi.fn(() => ({ passed: true, reason: 'ok' })),
  };
  const registry: Record<string, unknown> = {
    '@harness-one/anthropic': { createAnthropicAdapter: vi.fn(() => fakeAdapter('anthropic')) },
    '@harness-one/openai': {
      createOpenAIAdapter: vi.fn(() => fakeAdapter('openai')),
      sealProviders: vi.fn(),
      isProvidersSealed: () => true,
    },
    '@harness-one/devkit': {
      createEvalRunner: vi.fn(() => fakeRunner),
      createBasicRelevanceScorer: vi.fn(() => ({ name: 'relevance' })),
    },
  };

  return {
    ...actual,
    requireForFeature: (pkg: string, opts: { feature: string; install: string }) => {
      seam.requested.push(pkg);
      if (!seam.available.has(pkg)) {
        throw new HarnessError(
          `${opts.feature} needs the "${pkg}" package, which could not be loaded. `
            + `Install it with \`${opts.install}\`.`,
          HarnessErrorCode.CORE_INVALID_CONFIG,
          `Run \`${opts.install}\` to enable ${opts.feature}.`,
        );
      }
      return registry[pkg];
    },
    tryLoadOptional: (pkg: string) => (seam.available.has(pkg) ? registry[pkg] ?? null : null),
  };
});

import { createHarness } from '../index.js';
import type { AnthropicHarnessConfig, OpenAIHarnessConfig } from '../index.js';

const anthropicConfig = { provider: 'anthropic', client: {}, model: 'claude-x' } as unknown as AnthropicHarnessConfig;
const openaiConfig = { provider: 'openai', client: {}, model: 'gpt-x' } as unknown as OpenAIHarnessConfig;

beforeEach(() => {
  seam.requested.length = 0;
  seam.available.clear();
  for (const p of ['@harness-one/anthropic', '@harness-one/openai', '@harness-one/devkit']) {
    seam.available.add(p);
  }
});

describe('preset optional-peer wiring', () => {
  it('anthropic provider loads ONLY the anthropic adapter package', () => {
    createHarness(anthropicConfig);
    expect(seam.requested).toContain('@harness-one/anthropic');
    expect(seam.requested).not.toContain('@harness-one/openai');
    // eval is lazy: devkit is not touched during construction.
    expect(seam.requested).not.toContain('@harness-one/devkit');
  });

  it('openai provider loads ONLY the openai adapter package', () => {
    createHarness(openaiConfig);
    expect(seam.requested).toContain('@harness-one/openai');
    expect(seam.requested).not.toContain('@harness-one/anthropic');
  });

  it('throws an actionable HarnessError when the selected provider package is missing', () => {
    seam.available.delete('@harness-one/openai');
    let caught: unknown;
    try {
      createHarness(openaiConfig);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const err = caught as HarnessError;
    expect(err.code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
    expect(err.suggestion).toContain('npm install @harness-one/openai openai');
  });

  it('does not load @harness-one/devkit when harness.eval is never used (graceful)', () => {
    const harness = createHarness(anthropicConfig);
    expect(harness.eval).toBeDefined();
    expect(seam.requested).not.toContain('@harness-one/devkit');
  });

  it('loads devkit lazily on first eval use, then memoizes the runner', async () => {
    const harness = createHarness(anthropicConfig);

    const gate = harness.eval.checkGate({} as never);
    expect(gate).toEqual({ passed: true, reason: 'ok' });
    expect(seam.requested).toContain('@harness-one/devkit');

    // Second use must reuse the memoized runner — no additional devkit load.
    const loadsBefore = seam.requested.filter((p) => p === '@harness-one/devkit').length;
    await harness.eval.run([], async () => 'answer');
    const loadsAfter = seam.requested.filter((p) => p === '@harness-one/devkit').length;
    expect(loadsAfter).toBe(loadsBefore);
  });

  it('rejects eval calls with an actionable error when devkit is absent', async () => {
    seam.available.delete('@harness-one/devkit');
    // Construction must not throw — eval is not requested yet (graceful).
    const harness = createHarness(anthropicConfig);
    expect(harness.eval).toBeDefined();

    // Async methods reject; the sync method throws.
    await expect(harness.eval.run([], async () => 'x')).rejects.toBeInstanceOf(HarnessError);
    expect(() => harness.eval.checkGate({} as never)).toThrow(HarnessError);
  });
});
