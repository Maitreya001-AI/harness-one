import { describe, expect, it } from 'vitest';

import { buildCliRuntime } from '../../src/cli/build-runtime.js';
import { createMockAdapter } from '../../src/mock-adapter.js';
import { createFixtureSearchProvider } from '../../src/tools/web-search.js';
import { createFixtureFetcher } from '../../src/tools/web-fetch.js';
import type { EnvConfig } from '../../src/cli/env.js';

const baseCfg: EnvConfig = {
  mocked: true,
  model: 'm',
  budgetUsd: 1,
  reportsRoot: '/tmp/r',
  searchProvider: 'fixture',
};

describe('buildCliRuntime', () => {
  it('returns mock runtime when cfg.mocked is true', async () => {
    const rt = await buildCliRuntime(baseCfg);
    expect(rt.adapter.name).toBe('research-collab:mock');
    expect(rt.searchProvider.name).toBe('fixture');
  });

  it('uses live factories when not mocked', async () => {
    const liveCfg: EnvConfig = { ...baseCfg, mocked: false, anthropicApiKey: 'k' };
    const adapter = createMockAdapter();
    const search = createFixtureSearchProvider([]);
    const fetcher = createFixtureFetcher(new Map());
    const rt = await buildCliRuntime(liveCfg, {
      adapterFactory: async () => adapter,
      searchProviderFactory: () => search,
      fetcherFactory: () => fetcher,
    });
    expect(rt.adapter).toBe(adapter);
    expect(rt.searchProvider).toBe(search);
    expect(rt.fetcher).toBe(fetcher);
  });
});
