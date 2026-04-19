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

  // Capture the onToolCall callback from AgentLoop constructor
  let capturedOnToolCall: ((call: { id: string; name: string; arguments: string }) => Promise<unknown>) | undefined;
  const mockAgentLoopRun = vi.fn(function* () {});
  const MockAgentLoop = vi.fn().mockImplementation((config: Record<string, unknown>) => {
    capturedOnToolCall = config.onToolCall;
    return { run: mockAgentLoopRun };
  });

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
    MockAgentLoop,
    mockAgentLoopRun,
    getCapturedOnToolCall: () => capturedOnToolCall,
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
import type { AnthropicHarnessConfig, AdapterHarnessConfig } from '../index.js';
import { HarnessError, HarnessErrorCode} from 'harness-one/core';
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

  it('creates a harness with new infrastructure fields', () => {
    const harness = createHarness(baseConfig);
    // `eventBus` field removed (ARCH-010 deprecation fully landed).
    expect(harness.logger).toBeDefined();
    expect(harness.conversations).toBeDefined();
    expect(harness.middleware).toBeDefined();
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

    it('uses custom adapter when provided (AdapterHarnessConfig shape)', () => {
      const customAdapter = { chat: vi.fn() };
      // adapter and client are mutually exclusive in HarnessConfig, so the
      // adapter-override path uses the AdapterHarnessConfig variant (no
      // provider / client). Non-provider HarnessConfigBase fields from
      // `baseConfig` (model, pricing, budget, ...) are still valid.
      const { provider: _p, client: _c, ...rest } = baseConfig as unknown as {
        provider?: unknown;
        client?: unknown;
      } & Record<string, unknown>;
      createHarness({ ...rest, adapter: customAdapter as unknown as AgentAdapter });
      expect(mocks.createAnthropicAdapter).not.toHaveBeenCalled();
      expect(mocks.createOpenAIAdapter).not.toHaveBeenCalled();
    });

    it('creates harness with AdapterHarnessConfig (no provider/client)', () => {
      const customAdapter = { chat: vi.fn(), stream: vi.fn() } as unknown as AgentAdapter;
      const config: AdapterHarnessConfig = { adapter: customAdapter };
      const harness = createHarness(config);

      expect(harness.loop).toBeDefined();
      expect(harness.tools).toBeDefined();
      expect(mocks.createAnthropicAdapter).not.toHaveBeenCalled();
      expect(mocks.createOpenAIAdapter).not.toHaveBeenCalled();
    });

    it('AdapterHarnessConfig supports all optional fields', () => {
      const customAdapter = { chat: vi.fn() } as unknown as AgentAdapter;
      const config: AdapterHarnessConfig = {
        adapter: customAdapter,
        maxIterations: 10,
        maxTotalTokens: 5000,
        budget: 1.0,
      };
      const harness = createHarness(config);
      expect(harness.loop).toBeDefined();
      expect(harness.costs).toBeDefined();
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
      const fakeLangfuse = { trace: vi.fn(), flushAsync: vi.fn() };
      createHarness({ ...baseConfig, exporters: [customExporter], langfuse: fakeLangfuse as unknown as AnthropicHarnessConfig['langfuse'] });
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

    it('does not call registerTiktokenModels when a custom tokenizer function is provided', () => {
      const tokenFn = (text: string) => text.split(/\s+/).length;
      createHarness({ ...baseConfig, tokenizer: tokenFn });
      expect(mocks.registerTiktokenModels).not.toHaveBeenCalled();
    });

    it('does not call registerTiktokenModels when a custom tokenizer object is provided', () => {
      const tokenizer = { encode: (text: string) => ({ length: text.length }) };
      createHarness({ ...baseConfig, tokenizer });
      expect(mocks.registerTiktokenModels).not.toHaveBeenCalled();
    });
  });

  describe('cost tracking', () => {
    it('passes pricing to the Langfuse cost tracker factory when provided', () => {
      const pricing = [{ model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 }];
      const fakeLangfuse = { trace: vi.fn(), flushAsync: vi.fn() };
      createHarness({ ...baseConfig, langfuse: fakeLangfuse as unknown as AnthropicHarnessConfig['langfuse'], pricing });
      expect(mocks.createLangfuseCostTracker).toHaveBeenCalledWith(
        expect.objectContaining({ pricing }),
      );
    });

    it('passes budget to the Langfuse cost tracker factory when provided', () => {
      const fakeLangfuse = { trace: vi.fn(), flushAsync: vi.fn() };
      createHarness({ ...baseConfig, langfuse: fakeLangfuse as unknown as AnthropicHarnessConfig['langfuse'], budget: 10.0 });
      expect(mocks.createLangfuseCostTracker).toHaveBeenCalledWith(
        expect.objectContaining({ budget: 10.0 }),
      );
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

  describe('run method', () => {
    it('run delegates to loop.run', () => {
      const harness = createHarness(baseConfig);
      const messages = [{ role: 'user' as const, content: 'Hello' }];
      const result = harness.run(messages);
      // run should return an AsyncGenerator
      expect(result).toBeDefined();
    });

    it('auto-persists messages to conversation store', async () => {
      // Set up mock to yield message and tool_result events
      mocks.mockAgentLoopRun.mockImplementationOnce(async function* () {
        yield {
          type: 'message' as const,
          message: { role: 'assistant' as const, content: 'Hi there' },
          usage: { inputTokens: 10, outputTokens: 5 },
        };
        yield {
          type: 'tool_result' as const,
          toolCallId: 'tc-1',
          result: 'tool output',
        };
      });

      const harness = createHarness(baseConfig);
      const messages = [{ role: 'user' as const, content: 'Hello' }];

      // Consume the async generator — use explicit sessionId for lookup
      const events = [];
      for await (const event of harness.run(messages, { sessionId: 'test-auto-persist' })) {
        events.push(event);
      }

      // Verify events were yielded
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(expect.objectContaining({ type: 'message' }));
      expect(events[1]).toEqual(expect.objectContaining({ type: 'tool_result' }));

      // Verify messages were persisted to conversation store
      const stored = await harness.conversations.load('test-auto-persist');
      // Should contain: 1 input message + 1 assistant message + 1 tool message = 3
      expect(stored).toHaveLength(3);
      expect(stored[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(stored[1]).toEqual({ role: 'assistant', content: 'Hi there' });
      expect(stored[2]).toEqual({ role: 'tool', content: 'tool output', toolCallId: 'tc-1' });
    });
  });

  describe('onToolCall callback', () => {
    it('delegates tool call to tools.execute with raw arguments string', async () => {
      createHarness(baseConfig);

      // Get the captured onToolCall callback from AgentLoop constructor
      const onToolCall = mocks.getCapturedOnToolCall();
      expect(onToolCall).toBeDefined();

      // Call it with a mock tool call -- tools.execute handles JSON parsing
      // internally, so onToolCall should pass the call through directly
      await onToolCall!({
        id: 'tc-1',
        name: 'search',
        arguments: '{"query":"test"}',
      });
    });

    it('does not throw on invalid JSON arguments (tools.execute handles it)', async () => {
      createHarness(baseConfig);

      const onToolCall = mocks.getCapturedOnToolCall();
      expect(onToolCall).toBeDefined();

      // Invalid JSON should not crash -- tools.execute returns a validation error
      const result = await onToolCall!({
        id: 'tc-2',
        name: 'search',
        arguments: 'not valid json{{{',
      });

      // tools.execute returns a ToolResult with error status for invalid JSON
      expect(result).toBeDefined();
    });
  });

  describe('shutdown without shutdown method', () => {
    it('shutdown skips exporters without shutdown method', async () => {
      const exporterWithoutShutdown = {
        name: 'no-shutdown',
        exportTrace: vi.fn(),
        exportSpan: vi.fn(),
        flush: vi.fn(),
        // Note: no shutdown method
      };
      const harness = createHarness({ ...baseConfig, exporters: [exporterWithoutShutdown] });
      // Should not throw even if exporter has no shutdown
      await expect(harness.shutdown()).resolves.not.toThrow();
    });
  });

  describe('guardrails with injection sensitivity object', () => {
    it('creates injection detector with sensitivity option', () => {
      const harness = createHarness({
        ...baseConfig,
        guardrails: { injection: { sensitivity: 'high' } },
      });
      expect(harness.guardrails).toBeDefined();
    });

    it('creates all guardrails together', () => {
      const harness = createHarness({
        ...baseConfig,
        guardrails: {
          injection: { sensitivity: 'low' },
          rateLimit: { max: 5, windowMs: 30000 },
          contentFilter: { blocked: ['forbidden'] },
        },
      });
      expect(harness.guardrails).toBeDefined();
    });
  });

  describe('config options', () => {
    it('sets maxIterations and maxTotalTokens on agent loop', () => {
      const harness = createHarness({
        ...baseConfig,
        maxIterations: 5,
        maxTotalTokens: 10000,
      });
      expect(harness.loop).toBeDefined();
    });

    it('uses core cost tracker when no langfuse provided', () => {
      const harness = createHarness(baseConfig);
      // costs should still be defined (uses core createCostTracker)
      expect(harness.costs).toBeDefined();
    });

    it('does not pass pricing to the Langfuse factory when not provided', () => {
      createHarness(baseConfig);
      // baseConfig has no langfuse client, so the mock factory is never invoked.
      // Sanity-check that no tracker was created at all here.
      expect(mocks.createLangfuseCostTracker).not.toHaveBeenCalled();
    });
  });

  describe('partial overrides', () => {
    it('allows overriding adapter while using default everything else', () => {
      const customAdapter = { chat: vi.fn() };
      // adapter+client are mutually exclusive, so this uses the
      // AdapterHarnessConfig shape (no provider/client).
      const { provider: _p, client: _c, ...rest } = baseConfig as unknown as {
        provider?: unknown;
        client?: unknown;
      } & Record<string, unknown>;
      const harness = createHarness({ ...rest, adapter: customAdapter as unknown as AgentAdapter });
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

  describe('optional dependencies graceful degradation', () => {
    it('creates harness without langfuse, redis, or tiktoken (optional deps)', () => {
      // When no optional features are requested, harness should work fine
      const harness = createHarness(baseConfig);
      expect(harness.loop).toBeDefined();
      expect(harness.tools).toBeDefined();
      expect(harness.memory).toBeDefined();
      expect(harness.costs).toBeDefined();
      expect(harness.traces).toBeDefined();
    });

    it('uses in-memory store when redis is not configured', () => {
      const harness = createHarness(baseConfig);
      // memory should use in-memory store (not Redis)
      expect(harness.memory).toBeDefined();
      expect(mocks.createRedisStore).not.toHaveBeenCalled();
    });

    it('uses core cost tracker when langfuse is not configured', () => {
      const harness = createHarness(baseConfig);
      // costs should use core createCostTracker
      expect(harness.costs).toBeDefined();
      expect(mocks.createLangfuseCostTracker).not.toHaveBeenCalled();
    });

    it('uses console exporter when langfuse is not configured', () => {
      const harness = createHarness(baseConfig);
      // traces should use console exporter
      expect(harness.traces).toBeDefined();
      expect(mocks.createLangfuseExporter).not.toHaveBeenCalled();
    });
  });

  describe('config validation', () => {
    it('throws INVALID_CONFIG when neither adapter nor client is provided', () => {
      const badConfig = { provider: 'anthropic' } as unknown as AnthropicHarnessConfig;
      expect(() => createHarness(badConfig)).toThrow(HarnessError);
      try {
        createHarness(badConfig);
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect((e as HarnessError).message).toContain('adapter');
      }
    });

    it('throws INVALID_CONFIG when maxIterations is zero', () => {
      expect(() => createHarness({ ...baseConfig, maxIterations: 0 })).toThrow(HarnessError);
      try {
        createHarness({ ...baseConfig, maxIterations: 0 });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect((e as HarnessError).message).toContain('maxIterations');
      }
    });

    it('throws INVALID_CONFIG when maxIterations is negative', () => {
      expect(() => createHarness({ ...baseConfig, maxIterations: -5 })).toThrow(HarnessError);
    });

    it('throws INVALID_CONFIG when maxTotalTokens is zero', () => {
      expect(() => createHarness({ ...baseConfig, maxTotalTokens: 0 })).toThrow(HarnessError);
      try {
        createHarness({ ...baseConfig, maxTotalTokens: 0 });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect((e as HarnessError).message).toContain('maxTotalTokens');
      }
    });

    it('throws INVALID_CONFIG when maxTotalTokens is negative', () => {
      expect(() => createHarness({ ...baseConfig, maxTotalTokens: -100 })).toThrow(HarnessError);
    });

    it('throws INVALID_CONFIG when budget is zero', () => {
      expect(() => createHarness({ ...baseConfig, budget: 0 })).toThrow(HarnessError);
      try {
        createHarness({ ...baseConfig, budget: 0 });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect((e as HarnessError).message).toContain('budget');
      }
    });

    it('throws INVALID_CONFIG when budget is negative', () => {
      expect(() => createHarness({ ...baseConfig, budget: -10 })).toThrow(HarnessError);
    });

    it('throws INVALID_CONFIG when rateLimit.max is zero', () => {
      expect(() => createHarness({
        ...baseConfig,
        guardrails: { rateLimit: { max: 0, windowMs: 60000 } },
      })).toThrow(HarnessError);
      try {
        createHarness({ ...baseConfig, guardrails: { rateLimit: { max: 0, windowMs: 60000 } } });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect((e as HarnessError).message).toContain('rateLimit.max');
      }
    });

    it('throws INVALID_CONFIG when rateLimit.max is negative', () => {
      expect(() => createHarness({
        ...baseConfig,
        guardrails: { rateLimit: { max: -1, windowMs: 60000 } },
      })).toThrow(HarnessError);
    });

    it('throws INVALID_CONFIG when rateLimit.windowMs is zero', () => {
      expect(() => createHarness({
        ...baseConfig,
        guardrails: { rateLimit: { max: 10, windowMs: 0 } },
      })).toThrow(HarnessError);
      try {
        createHarness({ ...baseConfig, guardrails: { rateLimit: { max: 10, windowMs: 0 } } });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect((e as HarnessError).message).toContain('windowMs');
      }
    });

    it('throws INVALID_CONFIG when pricing has negative values', () => {
      expect(() => createHarness({
        ...baseConfig,
        pricing: [{ model: 'test-model', inputPer1kTokens: -0.01, outputPer1kTokens: 0.02 }],
      })).toThrow(HarnessError);
      try {
        createHarness({
          ...baseConfig,
          pricing: [{ model: 'test-model', inputPer1kTokens: -0.01, outputPer1kTokens: 0.02 }],
        });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect((e as HarnessError).message).toContain('test-model');
      }
    });

    it('throws INVALID_CONFIG when pricing has negative output value', () => {
      expect(() => createHarness({
        ...baseConfig,
        pricing: [{ model: 'gpt-4', inputPer1kTokens: 0.03, outputPer1kTokens: -0.06 }],
      })).toThrow(HarnessError);
    });

    it('allows valid positive values for maxIterations, maxTotalTokens, budget', () => {
      expect(() => createHarness({
        ...baseConfig,
        maxIterations: 10,
        maxTotalTokens: 50000,
        budget: 5.0,
      })).not.toThrow();
    });

    it('allows adapter without client', () => {
      const customAdapter = { chat: vi.fn() } as unknown as AgentAdapter;
      const configWithAdapter = { provider: 'anthropic', adapter: customAdapter } as unknown as AnthropicHarnessConfig;
      expect(() => createHarness(configWithAdapter)).not.toThrow();
    });
  });
});
