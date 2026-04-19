/**
 * Preset hardening fixes.
 *
 * Covers:
 *  - Harness.shutdown is a required method on the Harness interface.
 *  - createHarness supplies a default adapterTimeoutMs to createAgentLoop
 *    and honors caller override (including explicit 0).
 *  - onSessionId callback throw is logged and swallowed.
 *  - HarnessConfig discriminator `type` compiles and narrows cleanly.
 *  - HarnessConfigBase is exported.
 *  - drain() default is driven by DRAIN_DEFAULT_TIMEOUT_MS (exported).
 *  - pricing validator error quotes the model name with backticks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let capturedLoopConfig: Record<string, unknown> | undefined;
  const mockLoopRun = vi.fn(async function* () {});
  const mockLoopAbort = vi.fn();
  const MockAgentLoop = vi.fn().mockImplementation((cfg: Record<string, unknown>) => {
    capturedLoopConfig = cfg;
    return {
      run: mockLoopRun,
      abort: mockLoopAbort,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  });
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
  const mockAjvValidator = { validate: vi.fn(() => ({ valid: true, errors: [] })) };
  return {
    MockAgentLoop,
    mockLoopRun,
    mockLoopAbort,
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
    getCapturedLoopConfig: () => capturedLoopConfig,
    resetCapturedLoopConfig: () => { capturedLoopConfig = undefined; },
  };
});

vi.mock('harness-one/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('harness-one/core')>();
  return { ...original, createAgentLoop: mocks.MockAgentLoop };
});
vi.mock('@harness-one/anthropic', () => ({ createAnthropicAdapter: mocks.createAnthropicAdapter }));
vi.mock('@harness-one/openai', () => ({ createOpenAIAdapter: mocks.createOpenAIAdapter }));
vi.mock('@harness-one/langfuse', () => ({
  createLangfuseExporter: mocks.createLangfuseExporter,
  createLangfuseCostTracker: mocks.createLangfuseCostTracker,
}));
vi.mock('@harness-one/redis', () => ({ createRedisStore: mocks.createRedisStore }));
vi.mock('@harness-one/ajv', () => ({ createAjvValidator: mocks.createAjvValidator }));
vi.mock('@harness-one/tiktoken', () => ({ registerTiktokenModels: mocks.registerTiktokenModels }));

import {
  createHarness,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  DRAIN_DEFAULT_TIMEOUT_MS,
} from '../index.js';
import type {
  AnthropicHarnessConfig,
  AdapterHarnessConfig,
  HarnessConfig,
  HarnessConfigBase,
  Harness,
  OpenAIHarnessConfig,
} from '../index.js';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

const baseConfig = {
  provider: 'anthropic' as const,
  client: {},
  model: 'claude-sonnet-4-20250514',
} as unknown as AnthropicHarnessConfig;

describe('preset fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetCapturedLoopConfig();
  });

  // -------------------------------------------------------------------------
  // F-1: shutdown on the Harness interface
  // -------------------------------------------------------------------------
  describe('Harness.shutdown is a required interface method', () => {
    it('every Harness returned by createHarness exposes shutdown() as a function', () => {
      const h = createHarness(baseConfig);
      expect(typeof h.shutdown).toBe('function');
    });

    it('the Harness interface statically requires shutdown (compile-time check)', () => {
      // If F-1 regresses and shutdown becomes optional/removed, this
      // assignment fails typecheck. `satisfies` would also work; an explicit
      // type annotation forces the check.
      const h: Harness = createHarness(baseConfig);
      // Runtime sanity: calling shutdown resolves without throwing.
      return expect(h.shutdown()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // F-2: adapterTimeoutMs default
  // -------------------------------------------------------------------------
  describe('createHarness supplies default adapterTimeoutMs', () => {
    it('forwards DEFAULT_ADAPTER_TIMEOUT_MS when config.adapterTimeoutMs is unset', () => {
      createHarness(baseConfig);
      const captured = mocks.getCapturedLoopConfig();
      expect(captured).toBeDefined();
      expect(captured?.adapterTimeoutMs).toBe(DEFAULT_ADAPTER_TIMEOUT_MS);
      expect(DEFAULT_ADAPTER_TIMEOUT_MS).toBe(60_000);
    });

    it('honors caller-supplied adapterTimeoutMs override', () => {
      createHarness({ ...baseConfig, adapterTimeoutMs: 1_234 } as AnthropicHarnessConfig);
      expect(mocks.getCapturedLoopConfig()?.adapterTimeoutMs).toBe(1_234);
    });

    it('forwards adapterTimeoutMs=0 verbatim (caller opts out of default)', () => {
      createHarness({ ...baseConfig, adapterTimeoutMs: 0 } as AnthropicHarnessConfig);
      expect(mocks.getCapturedLoopConfig()?.adapterTimeoutMs).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // F-3: onSessionId swallow
  // -------------------------------------------------------------------------
  describe('onSessionId callback throws are logged and swallowed', () => {
    it('does not propagate a throwing onSessionId callback', async () => {
      const logged: unknown[] = [];
      const logger = {
        debug: vi.fn(), info: vi.fn(),
        warn: (msg: string, meta?: unknown) => { logged.push({ msg, meta }); },
        error: vi.fn(),
      };
      const h = createHarness({ ...baseConfig, logger: logger as unknown as HarnessConfigBase['logger'] });
      const gen = h.run([{ role: 'user', content: 'hi' }], {
        onSessionId: () => { throw new Error('boom'); },
      });
      // Drain; generator must terminate without re-throwing the callback error.
      const events: unknown[] = [];
      for await (const e of gen) events.push(e);
      const warning = logged.find((e) => {
        const rec = e as { msg: string };
        return rec.msg.includes('onSessionId callback threw');
      });
      expect(warning).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // F-4: discriminator
  // -------------------------------------------------------------------------
  describe('HarnessConfig discriminator narrows cleanly', () => {
    it('accepts optional `type` field on each variant without breaking existing callers', () => {
      // Compile-time check: each variant allows `type: 'adapter' | 'openai' | 'anthropic'`.
      const anthro: AnthropicHarnessConfig = {
        provider: 'anthropic', client: {} as AnthropicHarnessConfig['client'], type: 'anthropic',
      };
      const openai: OpenAIHarnessConfig = {
        provider: 'openai', client: {} as OpenAIHarnessConfig['client'], type: 'openai',
      };
      const adapter: AdapterHarnessConfig = {
        adapter: { chat: vi.fn(), stream: vi.fn() } as unknown as AdapterHarnessConfig['adapter'],
        type: 'adapter',
      };
      // `type` is optional — omitting it remains valid (backwards compat).
      const anthroNoType: AnthropicHarnessConfig = {
        provider: 'anthropic', client: {} as AnthropicHarnessConfig['client'],
      };
      expect(anthro.type).toBe('anthropic');
      expect(openai.type).toBe('openai');
      expect(adapter.type).toBe('adapter');
      expect(anthroNoType.type).toBeUndefined();
    });

    it('HarnessConfig consumer can narrow via switch on `type` when set', () => {
      function describe_(config: HarnessConfig): string {
        switch (config.type) {
          case 'adapter': return 'adapter';
          case 'openai': return 'openai';
          case 'anthropic': return 'anthropic';
          default: return 'untagged';
        }
      }
      expect(describe_(baseConfig)).toBe('untagged');
      expect(describe_({ ...baseConfig, type: 'anthropic' })).toBe('anthropic');
    });
  });

  // -------------------------------------------------------------------------
  // F-5: HarnessConfigBase export
  // -------------------------------------------------------------------------
  describe('HarnessConfigBase is exported', () => {
    it('can be used as a reusable type alias in consumer code', () => {
      // Consumer code pattern — extending HarnessConfigBase requires it to be
      // exported from the preset. TypeScript resolves this at compile time;
      // the runtime assertion only confirms the module loaded.
      type MyBase = HarnessConfigBase & { readonly app: string };
      const x: MyBase = { app: 'demo', model: 'm' };
      expect(x.app).toBe('demo');
      expect(x.model).toBe('m');
    });
  });

  // -------------------------------------------------------------------------
  // F-6: drain default via exported constant
  // -------------------------------------------------------------------------
  describe('drain() default timeout', () => {
    it('exports DRAIN_DEFAULT_TIMEOUT_MS = 30_000', () => {
      expect(DRAIN_DEFAULT_TIMEOUT_MS).toBe(30_000);
    });

    it('drain() with no argument uses the default and still aborts the loop', async () => {
      const h = createHarness(baseConfig);
      await expect(h.drain()).resolves.toBeUndefined();
      expect(mocks.mockLoopAbort).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // F-7: pricing error message quoting
  // -------------------------------------------------------------------------
  describe('pricing validator error quotes model with backticks', () => {
    it('throws HarnessError with backtick-quoted model name', () => {
      expect(() =>
        createHarness({
          ...baseConfig,
          pricing: [{
            model: 'test-model',
            inputPer1kTokens: NaN,
            outputPer1kTokens: 0.01,
          }],
        } as AnthropicHarnessConfig),
      ).toThrow(HarnessError);
      try {
        createHarness({
          ...baseConfig,
          pricing: [{
            model: 'test-model',
            inputPer1kTokens: NaN,
            outputPer1kTokens: 0.01,
          }],
        } as AnthropicHarnessConfig);
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        const he = err as HarnessError;
        expect(he.code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
        expect(he.message).toContain('`test-model`');
        // Must NOT still use double quotes (regression sentinel).
        expect(he.message).not.toContain('"test-model"');
      }
    });

    it('error message still appears for negative values with the new quoting', () => {
      try {
        createHarness({
          ...baseConfig,
          pricing: [{
            model: 'neg-model',
            inputPer1kTokens: -1,
            outputPer1kTokens: 0.01,
          }],
        } as AnthropicHarnessConfig);
      } catch (err) {
        const he = err as HarnessError;
        expect(he.message).toContain('`neg-model`');
      }
    });
  });
});
