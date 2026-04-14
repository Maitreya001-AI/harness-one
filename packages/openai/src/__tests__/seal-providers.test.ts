/**
 * Tests for the OpenAI adapter provider-registry seal (T11).
 *
 * Contract:
 *  - `sealProviders()` freezes the registry; subsequent `registerProvider`
 *    calls throw `HarnessError { code: 'PROVIDER_REGISTRY_SEALED' }`.
 *  - `isProvidersSealed()` reports the current state.
 *  - Sealing is idempotent — calling it twice is a no-op.
 *  - `createOpenAIAdapter()` does NOT auto-seal (risk-assessor TECH-11-03
 *    decision — only explicit seal is supported in Wave 5A).
 *  - `createOpenAIAdapter()` continues to work after seal for already-
 *    registered providers (seal blocks new *registrations* only, not reads).
 *
 * Module-scope caveat: the seal flag lives on the module singleton. Each test
 * case uses `vi.resetModules()` + dynamic re-import so state never leaks
 * between cases. This mirrors how a fresh bootstrap would look in a host
 * application.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level stable mock so the `openai` default export is replaced before
// `src/index.ts` is (re-)evaluated on each dynamic import.
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        },
      },
    })),
  };
});

// Shape of the pieces we pull out of a fresh module import.
type OpenAIModule = typeof import('../index.js');

async function loadFreshModule(): Promise<OpenAIModule> {
  vi.resetModules();
  // The `.js` suffix matches production import shape (ESM output).
  return (await import('../index.js')) as OpenAIModule;
}

describe('OpenAI adapter — provider registry seal (T11)', () => {
  beforeEach(() => {
    // Every test starts from a clean module graph to avoid cross-test
    // contamination of the `_providersSealed` module singleton.
    vi.resetModules();
  });

  it('defaults to unsealed: isProvidersSealed() is false and registerProvider succeeds', async () => {
    const mod = await loadFreshModule();

    expect(mod.isProvidersSealed()).toBe(false);

    // A fresh, valid provider registration must go through without error.
    expect(() =>
      mod.registerProvider('acme', { baseURL: 'https://api.acme.example/v1' }),
    ).not.toThrow();

    // And the new provider is visible via the exported `providers` map.
    expect(mod.providers.acme).toEqual({ baseURL: 'https://api.acme.example/v1' });
  });

  it('sealProviders() flips isProvidersSealed() to true', async () => {
    const mod = await loadFreshModule();

    expect(mod.isProvidersSealed()).toBe(false);
    mod.sealProviders();
    expect(mod.isProvidersSealed()).toBe(true);
  });

  it('after seal, registerProvider throws HarnessError with code PROVIDER_REGISTRY_SEALED and the provider name in the message', async () => {
    const mod = await loadFreshModule();
    const { HarnessError } = await import('harness-one/core');

    mod.sealProviders();

    let caught: unknown;
    try {
      mod.registerProvider('rogue', { baseURL: 'https://rogue.example/v1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HarnessError);
    const err = caught as InstanceType<typeof HarnessError>;
    expect(err.code).toBe('PROVIDER_REGISTRY_SEALED');
    expect(err.message).toMatch(/rogue/);
    expect(err.message).toMatch(/sealed/i);
    // A suggestion must be present to guide remediation.
    expect(err.suggestion).toBeTruthy();
  });

  it('sealProviders() is idempotent: calling it multiple times never throws and never flips state back', async () => {
    const mod = await loadFreshModule();

    expect(() => {
      mod.sealProviders();
      mod.sealProviders();
      mod.sealProviders();
    }).not.toThrow();

    expect(mod.isProvidersSealed()).toBe(true);

    // Post-idempotent-seal, registrations still fail with the sealed code —
    // i.e. the extra seal calls didn't accidentally reset internal state.
    const { HarnessError } = await import('harness-one/core');
    try {
      mod.registerProvider('late', { baseURL: 'https://late.example/v1' });
      throw new Error('expected registerProvider to throw after idempotent seal');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as InstanceType<typeof HarnessError>).code).toBe(
        'PROVIDER_REGISTRY_SEALED',
      );
    }
  });

  it('createOpenAIAdapter() does NOT auto-seal the registry (explicit-only API per TECH-11-03)', async () => {
    const mod = await loadFreshModule();

    // Build an adapter — this exercises `createOpenAIAdapter`'s init path.
    mod.createOpenAIAdapter({ apiKey: 'sk-test' });

    // If auto-seal had accidentally been introduced, this would be `true`.
    // The risk-assessor explicitly rejected that behaviour (principle of
    // least surprise), so we guard against regression here.
    expect(mod.isProvidersSealed()).toBe(false);

    // And a follow-up registerProvider call still works.
    expect(() =>
      mod.registerProvider('post-adapter', { baseURL: 'https://post.example/v1' }),
    ).not.toThrow();
  });

  it('happy path: register several providers, then seal, then build adapters against them', async () => {
    const mod = await loadFreshModule();

    mod.registerProvider('acme1', { baseURL: 'https://acme1.example/v1' });
    mod.registerProvider('acme2', { baseURL: 'https://acme2.example/v1' });

    mod.sealProviders();
    expect(mod.isProvidersSealed()).toBe(true);

    // Both custom providers should still be readable from the registry.
    expect(mod.providers.acme1?.baseURL).toBe('https://acme1.example/v1');
    expect(mod.providers.acme2?.baseURL).toBe('https://acme2.example/v1');

    // And adapter creation using those baseURLs continues to work post-seal.
    const adapter = mod.createOpenAIAdapter({
      baseURL: mod.providers.acme1!.baseURL,
      apiKey: 'sk-test',
      model: 'test-model',
    });
    expect(adapter.name).toBe('openai:test-model');
  });

  it('vi.resetModules() re-imports with a fresh unsealed state (isolation semantics)', async () => {
    // First module copy: seal it.
    const first = await loadFreshModule();
    first.sealProviders();
    expect(first.isProvidersSealed()).toBe(true);

    // Second module copy obtained after resetModules(): must start fresh.
    const second = await loadFreshModule();
    expect(second).not.toBe(first);
    expect(second.isProvidersSealed()).toBe(false);

    // Sanity-check: the first reference is still sealed (its closure retains
    // its own `_providersSealed` cell). This documents the singleton-per-
    // module-instance semantics callers can rely on.
    expect(first.isProvidersSealed()).toBe(true);
  });

  it('after seal, createOpenAIAdapter still works for providers registered before the seal (seal blocks writes, not reads)', async () => {
    const mod = await loadFreshModule();

    mod.registerProvider('precious', { baseURL: 'https://precious.example/v1' });
    mod.sealProviders();

    // Build an adapter against the pre-sealed provider's baseURL — this must
    // succeed; seal is *registration*-scoped, not *consumption*-scoped.
    const adapter = mod.createOpenAIAdapter({
      baseURL: mod.providers.precious!.baseURL,
      apiKey: 'sk-test',
    });
    expect(adapter).toBeDefined();
    expect(typeof adapter.chat).toBe('function');
    expect(typeof adapter.stream).toBe('function');

    // And a fresh call to chat() drives through to the mocked OpenAI client
    // without tripping any seal-related guard.
    const res = await adapter.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.message.role).toBe('assistant');
  });

  it('seal error message preserves provider name across different inputs (name is not sanitized away)', async () => {
    // This guards against an accidental "swallow the name" regression in the
    // seal-check branch of registerProvider.
    const mod = await loadFreshModule();
    const { HarnessError } = await import('harness-one/core');

    mod.sealProviders();

    for (const name of ['alpha', 'beta-2', 'with.dots']) {
      try {
        mod.registerProvider(name, { baseURL: 'https://x.example/v1' });
        throw new Error(`expected throw for name="${name}"`);
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        const e = err as InstanceType<typeof HarnessError>;
        expect(e.code).toBe('PROVIDER_REGISTRY_SEALED');
        expect(e.message).toContain(name);
      }
    }
  });
});
