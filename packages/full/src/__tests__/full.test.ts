import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// All mocks must be hoisted and set up before any real imports
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockAnthropicAdapter = { chat: vi.fn(), stream: vi.fn() };
  const mockOpenAIAdapter = { chat: vi.fn(), stream: vi.fn() };
  const mockLangfuseExporter = {
    name: 'langfuse',
    exportTrace: vi.fn(),
    exportSpan: vi.fn(),
    flush: vi.fn(),
    shutdown: vi.fn(),
  };
  const mockLangfusePromptBackend = { fetch: vi.fn(), list: vi.fn() };
  const mockLangfuseCostTracker = {
    setPricing: vi.fn(),
    recordUsage: vi.fn(),
    getTotalCost: vi.fn(() => 0),
    getCostByModel: vi.fn(() => ({})),
    getCostByTrace: vi.fn(() => 0),
    setBudget: vi.fn(),
    checkBudget: vi.fn(() => null),
    onAlert: vi.fn(),
    reset: vi.fn(),
  };
  const mockRedisStore = {
    write: vi.fn(), read: vi.fn(), query: vi.fn(), update: vi.fn(),
    delete: vi.fn(), compact: vi.fn(), count: vi.fn(), clear: vi.fn(),
  };
  const mockAjvValidator = {
    validate: vi.fn(() => ({ valid: true, errors: [] })),
  };

  return {
    mockAnthropicAdapter,
    mockOpenAIAdapter,
    mockLangfuseExporter,
    mockLangfusePromptBackend,
    mockLangfuseCostTracker,
    mockRedisStore,
    mockAjvValidator,
    createAnthropicAdapter: vi.fn(() => mockAnthropicAdapter),
    createOpenAIAdapter: vi.fn(() => mockOpenAIAdapter),
    createLangfuseExporter: vi.fn(() => mockLangfuseExporter),
    createLangfusePromptBackend: vi.fn(() => mockLangfusePromptBackend),
    createLangfuseCostTracker: vi.fn(() => mockLangfuseCostTracker),
    createRedisStore: vi.fn(() => mockRedisStore),
    createAjvValidator: vi.fn(() => mockAjvValidator),
    registerTiktokenModels: vi.fn(),
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
  createLangfusePromptBackend: mocks.createLangfusePromptBackend,
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
import type { AgentAdapter } from 'harness-one/core';
import type { MemoryStore } from 'harness-one/memory';
import type { SchemaValidator } from 'harness-one/tools';

describe('createHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // All adapters are mocked — client shape doesn't matter at runtime
  const baseConfig = {
    provider: 'anthropic',
    client: {},
    model: 'claude-sonnet-4-20250514',
  } as unknown as AnthropicHarnessConfig;

  it('creates a harness with all required fields', () => {
    const harness = createHarness(baseConfig);

    expect(harness.loop).toBeDefined();
    expect(harness.tools).toBeDefined();
    expect(harness.guardrails).toBeDefined();
    expect(harness.traces).toBeDefined();
    expect(harness.costs).toBeDefined();
    expect(harness.sessions).toBeDefined();
    expect(harness.memory).toBeDefined();
    expect(harness.prompts).toBeDefined();
    expect(harness.eval).toBeDefined();
    expect(typeof harness.run).toBe('function');
    expect(typeof harness.shutdown).toBe('function');
  });

  describe('adapter wiring', () => {
    it('creates Anthropic adapter when provider is "anthropic"', () => {
      createHarness({ ...baseConfig, provider: 'anthropic' });
      expect(mocks.createAnthropicAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ client: baseConfig.client, model: baseConfig.model }),
      );
    });

    it('creates OpenAI adapter when provider is "openai"', () => {
      createHarness({ ...baseConfig, provider: 'openai' } as unknown as AnthropicHarnessConfig);
      expect(mocks.createOpenAIAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ client: baseConfig.client, model: baseConfig.model }),
      );
    });

    it('uses custom adapter when provided', () => {
      const customAdapter = { chat: vi.fn() };
      createHarness({ ...baseConfig, adapter: customAdapter as unknown as AgentAdapter });
      expect(mocks.createAnthropicAdapter).not.toHaveBeenCalled();
      expect(mocks.createOpenAIAdapter).not.toHaveBeenCalled();
    });
  });

  describe('langfuse wiring', () => {
    it('sets up Langfuse exporter when langfuse client provided', () => {
      const langfuseClient = { trace: vi.fn(), flushAsync: vi.fn() };
      createHarness({ ...baseConfig, langfuse: langfuseClient });

      expect(mocks.createLangfuseExporter).toHaveBeenCalledWith({ client: langfuseClient });
      expect(mocks.createLangfuseCostTracker).toHaveBeenCalledWith({ client: langfuseClient });
    });

    it('uses console exporter when no langfuse provided', () => {
      createHarness(baseConfig);
      expect(mocks.createLangfuseExporter).not.toHaveBeenCalled();
    });

    it('uses custom exporters when provided', () => {
      const customExporter = {
        name: 'custom',
        exportTrace: vi.fn(),
        exportSpan: vi.fn(),
        flush: vi.fn(),
      };
      createHarness({ ...baseConfig, exporters: [customExporter], langfuse: {} as AnthropicHarnessConfig['langfuse'] });
      expect(mocks.createLangfuseExporter).not.toHaveBeenCalled();
    });
  });

  describe('memory wiring', () => {
    it('sets up Redis store when redis client provided', () => {
      const redisClient = { get: vi.fn() };
      createHarness({ ...baseConfig, redis: redisClient });
      expect(mocks.createRedisStore).toHaveBeenCalledWith({ client: redisClient });
    });

    it('uses in-memory store when no redis provided', () => {
      const harness = createHarness(baseConfig);
      expect(mocks.createRedisStore).not.toHaveBeenCalled();
      expect(harness.memory).toBeDefined();
    });

    it('uses custom memory store when provided', () => {
      const customStore: MemoryStore = {
        write: vi.fn(), read: vi.fn(), query: vi.fn(), update: vi.fn(),
        delete: vi.fn(), compact: vi.fn(), count: vi.fn(), clear: vi.fn(),
      } as unknown as MemoryStore;
      const harness = createHarness({ ...baseConfig, memoryStore: customStore, redis: {} as AnthropicHarnessConfig['redis'] });
      expect(mocks.createRedisStore).not.toHaveBeenCalled();
      expect(harness.memory).toBe(customStore);
    });
  });

  describe('schema validator wiring', () => {
    it('creates Ajv validator by default', () => {
      createHarness(baseConfig);
      expect(mocks.createAjvValidator).toHaveBeenCalled();
    });

    it('uses custom schema validator when provided', () => {
      const customValidator = { validate: vi.fn(() => ({ valid: true, errors: [] })) } as unknown as SchemaValidator;
      createHarness({ ...baseConfig, schemaValidator: customValidator });
      // When override is provided, Ajv should NOT be called
      expect(mocks.createAjvValidator).not.toHaveBeenCalled();
    });
  });

  describe('tokenizer wiring', () => {
    it('registers tiktoken models when tokenizer is "tiktoken"', () => {
      createHarness({ ...baseConfig, tokenizer: 'tiktoken' });
      expect(mocks.registerTiktokenModels).toHaveBeenCalled();
    });

    it('does not register tiktoken by default', () => {
      createHarness(baseConfig);
      expect(mocks.registerTiktokenModels).not.toHaveBeenCalled();
    });
  });

  describe('cost tracking', () => {
    it('sets pricing when provided', () => {
      const pricing = [{ model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 }];
      createHarness({ ...baseConfig, langfuse: {} as AnthropicHarnessConfig['langfuse'], pricing });
      expect(mocks.mockLangfuseCostTracker.setPricing).toHaveBeenCalledWith(pricing);
    });

    it('sets budget when provided', () => {
      createHarness({ ...baseConfig, langfuse: {} as AnthropicHarnessConfig['langfuse'], budget: 10.0 });
      expect(mocks.mockLangfuseCostTracker.setBudget).toHaveBeenCalledWith(10.0);
    });
  });

  describe('guardrails wiring', () => {
    it('creates guardrail pipeline with injection detector', () => {
      const harness = createHarness({
        ...baseConfig,
        guardrails: { injection: true },
      });
      expect(harness.guardrails).toBeDefined();
    });

    it('creates guardrail pipeline with rate limiter', () => {
      const harness = createHarness({
        ...baseConfig,
        guardrails: { rateLimit: { max: 10, windowMs: 60000 } },
      });
      expect(harness.guardrails).toBeDefined();
    });

    it('creates guardrail pipeline with content filter', () => {
      const harness = createHarness({
        ...baseConfig,
        guardrails: { contentFilter: { blocked: ['bad'] } },
      });
      expect(harness.guardrails).toBeDefined();
    });

    it('creates empty guardrail pipeline when no guardrails configured', () => {
      const harness = createHarness(baseConfig);
      expect(harness.guardrails).toBeDefined();
    });
  });

  describe('shutdown', () => {
    it('flushes traces and shuts down exporters', async () => {
      const langfuseClient = { trace: vi.fn(), flushAsync: vi.fn() };
      const harness = createHarness({ ...baseConfig, langfuse: langfuseClient });
      await harness.shutdown();
      expect(mocks.mockLangfuseExporter.shutdown).toHaveBeenCalled();
    });
  });

  describe('partial overrides', () => {
    it('allows overriding adapter while using default everything else', () => {
      const customAdapter = { chat: vi.fn() };
      const harness = createHarness({ ...baseConfig, adapter: customAdapter as unknown as AgentAdapter });
      expect(harness.loop).toBeDefined();
      expect(harness.memory).toBeDefined();
      expect(mocks.createAnthropicAdapter).not.toHaveBeenCalled();
    });

    it('allows overriding memory while using default adapter', () => {
      const customStore = {
        write: vi.fn(), read: vi.fn(), query: vi.fn(), update: vi.fn(),
        delete: vi.fn(), compact: vi.fn(), count: vi.fn(), clear: vi.fn(),
      } as unknown as MemoryStore;
      const harness = createHarness({ ...baseConfig, memoryStore: customStore });
      expect(harness.memory).toBe(customStore);
      expect(mocks.createAnthropicAdapter).toHaveBeenCalled();
    });
  });
});
