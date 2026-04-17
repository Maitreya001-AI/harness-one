/**
 * Wave-13 Track G — OpenAI adapter fixes.
 *
 * Covers:
 *  - G-1 (P0-3): per-instance zero-usage warned-models LRU (no cross-tenant
 *    contamination of the warn-once dedupe).
 *  - G-2: `registerProvider()` honors `trustedOrigins` whitelist; origin
 *    mismatch throws PROVIDER_REGISTRY_SEALED.
 *  - G-3: `providers` constant is deep-frozen (outer and inner entries).
 *  - G-4: `registerProvider(name)` shorthand using bundled `providers` map.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOpenAIConstructor } = vi.hoisted(() => {
  const mockCreateFn = vi.fn();
  const mockOpenAIConstructor = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreateFn } },
    _mockCreate: mockCreateFn,
  }));
  return { mockOpenAIConstructor };
});

vi.mock('openai', () => ({ default: mockOpenAIConstructor }));

import {
  createOpenAIAdapter,
  registerProvider,
  providers,
  _resetOpenAIWarnState,
} from '../index.js';
import type { OpenAIAdapterConfig } from '../index.js';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

function createMockClient(): {
  client: NonNullable<OpenAIAdapterConfig['client']>;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn();
  return {
    client: { chat: { completions: { create } } } as unknown as NonNullable<OpenAIAdapterConfig['client']>,
    create,
  };
}

// ---------------------------------------------------------------------------
// G-1 (P0-3): per-instance zero-usage warn-once dedupe
// ---------------------------------------------------------------------------

describe('Wave-13 G-1: per-instance zero-usage warned-models LRU', () => {
  beforeEach(() => {
    _resetOpenAIWarnState();
  });

  it('two adapter instances for the same model each warn independently (no cross-instance silencing)', async () => {
    const logger1 = { warn: vi.fn(), error: vi.fn() };
    const logger2 = { warn: vi.fn(), error: vi.fn() };
    const mock1 = createMockClient();
    const mock2 = createMockClient();
    // Response missing prompt_tokens/completion_tokens triggers the warn path.
    const missingUsage = {
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: {},
    };
    mock1.create.mockResolvedValue(missingUsage);
    mock2.create.mockResolvedValue(missingUsage);

    const a1 = createOpenAIAdapter({ client: mock1.client, model: 'gpt-4o', logger: logger1 });
    const a2 = createOpenAIAdapter({ client: mock2.client, model: 'gpt-4o', logger: logger2 });

    await a1.chat({ messages: [{ role: 'user', content: 'hi' }] });
    await a2.chat({ messages: [{ role: 'user', content: 'hi' }] });

    // Each instance should warn exactly once for its own model.
    expect(logger1.warn).toHaveBeenCalledTimes(1);
    expect(logger2.warn).toHaveBeenCalledTimes(1);
  });

  it('a single adapter instance only warns once per model across many calls', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const mock = createMockClient();
    mock.create.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: {},
    });
    const a = createOpenAIAdapter({ client: mock.client, model: 'gpt-4o', logger });
    await a.chat({ messages: [{ role: 'user', content: 'hi' }] });
    await a.chat({ messages: [{ role: 'user', content: 'hi' }] });
    await a.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// G-2: trustedOrigins whitelist
// ---------------------------------------------------------------------------

describe('Wave-13 G-2: registerProvider honors trustedOrigins whitelist', () => {
  it('accepts a baseURL whose origin is on the whitelist', () => {
    // Use a unique name per test to avoid colliding with other suites.
    expect(() =>
      registerProvider(
        'wave13-g2-accept',
        { baseURL: 'https://api.example-accept.test/v1' },
        { trustedOrigins: ['https://api.example-accept.test'] },
      ),
    ).not.toThrow();
  });

  it('rejects a baseURL whose origin is not on the whitelist', () => {
    try {
      registerProvider(
        'wave13-g2-reject',
        { baseURL: 'https://api.hostile.test/v1' },
        { trustedOrigins: ['https://api.trusted.test'] },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      const he = err as HarnessError;
      expect(he.code).toBe(HarnessErrorCode.PROVIDER_REGISTRY_SEALED);
      expect(he.message).toContain('https://api.hostile.test');
      expect(he.message).toContain('trustedOrigins');
    }
  });

  it('does not enforce the whitelist when trustedOrigins is omitted', () => {
    expect(() =>
      registerProvider(
        'wave13-g2-omitted',
        { baseURL: 'https://api.anything-goes.test/v1' },
      ),
    ).not.toThrow();
  });

  it('does not enforce the whitelist when trustedOrigins is empty', () => {
    // Empty list is treated as "no whitelist configured" (same as undefined).
    expect(() =>
      registerProvider(
        'wave13-g2-empty',
        { baseURL: 'https://api.empty-list.test/v1' },
        { trustedOrigins: [] },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// G-3: providers deep-freeze
// ---------------------------------------------------------------------------

describe('Wave-13 G-3: providers entries are deep-frozen', () => {
  it('each bundled provider entry returned by the proxy is frozen', () => {
    const groq = providers.groq;
    expect(groq).toBeDefined();
    expect(Object.isFrozen(groq)).toBe(true);
  });

  it('mutation attempt on a provider entry throws in strict mode', () => {
    const entry = providers.groq;
    expect(entry).toBeDefined();
    expect(() => {
      (entry as { baseURL: string }).baseURL = 'https://evil.test';
    }).toThrow(TypeError);
  });

  it('assigning a new key on providers is rejected by the proxy', () => {
    expect(() => {
      (providers as unknown as Record<string, { baseURL: string }>).rogue = { baseURL: 'https://evil.test' };
    }).toThrow(TypeError);
  });

  it('deleting an existing key on providers is rejected by the proxy', () => {
    expect(() => {
      delete (providers as unknown as Record<string, unknown>).groq;
    }).toThrow(TypeError);
  });

  it('providers still surfaces entries registered via registerProvider()', () => {
    // Sanity: proxy is not a snapshot; late-registered entries must appear.
    registerProvider('wave13-g3-late', { baseURL: 'https://late.example.test/v1' });
    expect(providers['wave13-g3-late']?.baseURL).toBe('https://late.example.test/v1');
    // And the returned entry is still frozen.
    expect(Object.isFrozen(providers['wave13-g3-late'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G-4: registerProvider(name) shorthand
// ---------------------------------------------------------------------------

describe('Wave-13 G-4: registerProvider shorthand uses bundled providers', () => {
  it('registerProvider("groq") is idempotent (same bundled baseURL)', () => {
    // `groq` is already bundled; calling the shorthand form should not throw
    // (idempotent re-registration with the same baseURL is a no-op).
    expect(() => registerProvider('groq')).not.toThrow();
  });

  it('registerProvider("openrouter") uses the bundled baseURL', () => {
    expect(() => registerProvider('openrouter')).not.toThrow();
  });

  it('throws when name is not a bundled provider and config is omitted', () => {
    try {
      // Intentional wrong type: the shorthand overload is typed to
      // `keyof typeof providers` but we are probing the runtime fallback.
      (registerProvider as unknown as (name: string) => void)('not-a-bundled-provider');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      const he = err as HarnessError;
      expect(he.code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
      expect(he.message).toContain('not a bundled provider');
    }
  });
});
