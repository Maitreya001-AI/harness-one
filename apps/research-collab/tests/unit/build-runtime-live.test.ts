import { describe, expect, it } from 'vitest';

import { buildCliRuntime } from '../../src/cli/build-runtime.js';
import { createMockAdapter } from '../../src/mock-adapter.js';
import type { EnvConfig } from '../../src/cli/env.js';

const liveCfg = (overrides: Partial<EnvConfig> = {}): EnvConfig => ({
  mocked: false,
  model: 'm',
  budgetUsd: 1,
  reportsRoot: '/tmp/r',
  searchProvider: 'serpapi',
  anthropicApiKey: 'k',
  serpapiApiKey: 's',
  ...overrides,
});

describe('buildCliRuntime live defaults', () => {
  it('builds the default serpapi search provider when not overridden', async () => {
    const rt = await buildCliRuntime(liveCfg(), {
      adapterFactory: async () => createMockAdapter(),
    });
    expect(rt.searchProvider.name).toBe('serpapi');
  });

  it('builds the default brave search provider when configured', async () => {
    const rt = await buildCliRuntime(
      liveCfg({ searchProvider: 'brave', serpapiApiKey: undefined as never, braveApiKey: 'b' }),
      { adapterFactory: async () => createMockAdapter() },
    );
    expect(rt.searchProvider.name).toBe('brave');
  });

  it('falls back to fixture provider when env says fixture', async () => {
    const rt = await buildCliRuntime(
      liveCfg({ searchProvider: 'fixture' }),
      { adapterFactory: async () => createMockAdapter() },
    );
    expect(rt.searchProvider.name).toBe('fixture');
  });

  it('throws when serpapi selected without key', async () => {
    await expect(
      buildCliRuntime(liveCfg({ serpapiApiKey: undefined as never }), {
        adapterFactory: async () => createMockAdapter(),
      }),
    ).rejects.toThrow(/SERPAPI_API_KEY/);
  });

  it('throws when brave selected without key', async () => {
    await expect(
      buildCliRuntime(liveCfg({ searchProvider: 'brave' as const, serpapiApiKey: undefined as never }), {
        adapterFactory: async () => createMockAdapter(),
      }),
    ).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
  });

  it('builds the default http fetcher when not overridden', async () => {
    const rt = await buildCliRuntime(liveCfg(), {
      adapterFactory: async () => createMockAdapter(),
    });
    // Smoke check that the fetcher exists; we don't fire it.
    expect(typeof rt.fetcher.fetch).toBe('function');
  });

  it('throws on missing anthropic key when default adapter factory runs', async () => {
    await expect(
      buildCliRuntime(liveCfg({ anthropicApiKey: undefined as never })),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
