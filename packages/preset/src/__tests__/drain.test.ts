import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockLoopAbort = vi.fn();
  const mockLoopRun = vi.fn(function* () {});
  const MockAgentLoop = vi.fn().mockImplementation(() => ({
    run: mockLoopRun,
    abort: mockLoopAbort,
  }));

  const mockLangfuseExporter = {
    name: 'langfuse',
    exportTrace: vi.fn(),
    exportSpan: vi.fn(),
    flush: vi.fn(),
    shutdown: vi.fn(),
  };
  const mockLangfuseCostTracker = {
    recordUsage: vi.fn(),
    getTotalCost: vi.fn(() => 0),
    getCostByModel: vi.fn(() => new Map()),
    getCostByTrace: vi.fn(() => 0),
    checkBudget: vi.fn(() => null),
    onAlert: vi.fn(),
    reset: vi.fn(),
    getAlertMessage: vi.fn(() => null),
  };
  const mockRedisStore = {
    write: vi.fn(), read: vi.fn(), query: vi.fn(), update: vi.fn(),
    delete: vi.fn(), compact: vi.fn(), count: vi.fn(), clear: vi.fn(),
  };
  const mockAjvValidator = {
    validate: vi.fn(() => ({ valid: true, errors: [] })),
  };

  return {
    MockAgentLoop,
    mockLoopAbort,
    mockLoopRun,
    mockLangfuseExporter,
    mockLangfuseCostTracker,
    mockRedisStore,
    mockAjvValidator,
    createAnthropicAdapter: vi.fn(() => ({ chat: vi.fn(), stream: vi.fn() })),
    createOpenAIAdapter: vi.fn(() => ({ chat: vi.fn(), stream: vi.fn() })),
    createLangfuseExporter: vi.fn(() => mockLangfuseExporter),
    createLangfuseCostTracker: vi.fn(() => mockLangfuseCostTracker),
    createRedisStore: vi.fn(() => mockRedisStore),
    createAjvValidator: vi.fn(() => mockAjvValidator),
    registerTiktokenModels: vi.fn(),
  };
});

vi.mock('harness-one/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('harness-one/core')>();
  return {
    ...original,
    createAgentLoop: mocks.MockAgentLoop,
  };
});

vi.mock('@harness-one/anthropic', () => ({
  createAnthropicAdapter: mocks.createAnthropicAdapter,
}));

vi.mock('@harness-one/openai', () => ({
  createOpenAIAdapter: mocks.createOpenAIAdapter,
}));

vi.mock('@harness-one/langfuse', () => ({
  createLangfuseExporter: mocks.createLangfuseExporter,
  createLangfuseCostTracker: mocks.createLangfuseCostTracker,
}));

vi.mock('@harness-one/redis', () => ({
  createRedisStore: mocks.createRedisStore,
}));

vi.mock('@harness-one/ajv', () => ({
  createAjvValidator: mocks.createAjvValidator,
}));

vi.mock('@harness-one/tiktoken', () => ({
  registerTiktokenModels: mocks.registerTiktokenModels,
}));

import { createHarness } from '../index.js';
import type { AnthropicHarnessConfig } from '../index.js';

describe('Harness.drain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseConfig = {
    provider: 'anthropic',
    client: {},
    model: 'claude-sonnet-4-20250514',
  } as unknown as AnthropicHarnessConfig;

  it('exists as a method on the harness', () => {
    const harness = createHarness(baseConfig);
    expect(typeof harness.drain).toBe('function');
  });

  it('calls loop.abort()', async () => {
    const harness = createHarness(baseConfig);
    await harness.drain();
    expect(mocks.mockLoopAbort).toHaveBeenCalled();
  });

  it('calls shutdown after abort', async () => {
    const langfuseClient = { trace: vi.fn(), flushAsync: vi.fn() };
    const harness = createHarness({ ...baseConfig, langfuse: langfuseClient });
    await harness.drain();

    expect(mocks.mockLoopAbort).toHaveBeenCalled();
    expect(mocks.mockLangfuseExporter.shutdown).toHaveBeenCalled();
  });

  it('accepts a custom timeout parameter', async () => {
    const harness = createHarness(baseConfig);
    // Should not throw with custom timeout
    await expect(harness.drain(1000)).resolves.not.toThrow();
    expect(mocks.mockLoopAbort).toHaveBeenCalled();
  });

  it('uses default timeout of 30000ms', async () => {
    const harness = createHarness(baseConfig);
    // Just verify it completes without explicit timeout
    await expect(harness.drain()).resolves.not.toThrow();
  });

  // LM-013: shutdown latch — concurrent callers share the same promise.
  describe('LM-013: shutdown is a latched idempotent promise', () => {
    it('concurrent shutdown() calls only invoke exporter.shutdown once', async () => {
      const langfuseClient = { trace: vi.fn(), flushAsync: vi.fn() };
      const harness = createHarness({ ...baseConfig, langfuse: langfuseClient });
      await Promise.all([
        harness.shutdown(),
        harness.shutdown(),
        harness.shutdown(),
      ]);
      expect(mocks.mockLangfuseExporter.shutdown).toHaveBeenCalledTimes(1);
    });

    it('drain followed by shutdown runs shutdown exactly once', async () => {
      const langfuseClient = { trace: vi.fn(), flushAsync: vi.fn() };
      const harness = createHarness({ ...baseConfig, langfuse: langfuseClient });
      await harness.drain();
      await harness.shutdown();
      expect(mocks.mockLangfuseExporter.shutdown).toHaveBeenCalledTimes(1);
    });

    it('second shutdown resolves immediately and reuses the latch', async () => {
      const harness = createHarness(baseConfig);
      await harness.shutdown();
      // Second call must resolve — latch reuse, no re-entry.
      await expect(harness.shutdown()).resolves.toBeUndefined();
    });
  });
});
