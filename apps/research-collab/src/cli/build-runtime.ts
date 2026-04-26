/**
 * Build the runtime dependencies (adapter + search provider + fetcher) the
 * CLI needs from a parsed env config.
 *
 * Kept separate from `bin.ts` so unit tests can swap individual factories
 * without instantiating the full process entry point.
 */

import type { AgentAdapter } from 'harness-one/core';

import { createMockAdapter, DEFAULT_SCRIPT } from '../mock-adapter.js';
import {
  createBraveSearchProvider,
  createFixtureSearchProvider,
  createSerpApiProvider,
  type WebSearchProvider,
} from '../tools/web-search.js';
import {
  createHttpFetcher,
  createFixtureFetcher,
  type FetchedPage,
  type WebFetcher,
} from '../tools/web-fetch.js';
import { nativeFetchClient } from '../tools/http.js';

import type { EnvConfig } from './env.js';

export interface CliRuntime {
  readonly adapter: AgentAdapter;
  readonly searchProvider: WebSearchProvider;
  readonly fetcher: WebFetcher;
}

export interface BuildRuntimeOptions {
  /** Override the live-mode adapter factory. Tests inject a deterministic stub. */
  readonly adapterFactory?: (cfg: EnvConfig) => Promise<AgentAdapter>;
  /** Override the live-mode search provider. */
  readonly searchProviderFactory?: (cfg: EnvConfig) => WebSearchProvider;
  /** Override the live-mode web fetcher. */
  readonly fetcherFactory?: (cfg: EnvConfig) => WebFetcher;
}

/**
 * Build the runtime, lazily importing the Anthropic SDK so mock-mode runs
 * never touch a network-dependent package.
 */
export async function buildCliRuntime(
  cfg: EnvConfig,
  options: BuildRuntimeOptions = {},
): Promise<CliRuntime> {
  const adapter = cfg.mocked
    ? createMockAdapter()
    : await (options.adapterFactory ?? defaultAnthropicAdapter)(cfg);

  const searchProvider = cfg.mocked
    ? createFixtureSearchProvider([])
    : (options.searchProviderFactory ?? defaultSearchProvider)(cfg);

  const fetcher = cfg.mocked
    ? createFixtureFetcher(buildMockFixturePages())
    : (options.fetcherFactory ?? defaultHttpFetcher)(cfg);

  return { adapter, searchProvider, fetcher };
}

/**
 * Pre-populate the fixture fetcher with the URLs the {@link DEFAULT_SCRIPT}
 * cites. The mock adapter issues `web_fetch` for every citation URL so the
 * Specialist's `fetchedUrls` set is populated; if the fetcher doesn't know
 * those URLs, the call returns an error and the parser later rejects the
 * answer's citations.
 */
function buildMockFixturePages(): ReadonlyMap<string, FetchedPage> {
  const pages = new Map<string, FetchedPage>();
  for (const ans of DEFAULT_SCRIPT.specialistAnswers) {
    for (const c of ans.citations) {
      pages.set(c.url, {
        url: c.url,
        title: c.title,
        content: c.excerpt,
        bytes: new TextEncoder().encode(c.excerpt).byteLength,
      });
    }
  }
  for (const c of DEFAULT_SCRIPT.report.citations) {
    if (!pages.has(c.url)) {
      pages.set(c.url, {
        url: c.url,
        title: c.title,
        content: c.excerpt,
        bytes: new TextEncoder().encode(c.excerpt).byteLength,
      });
    }
  }
  return pages;
}

async function defaultAnthropicAdapter(cfg: EnvConfig): Promise<AgentAdapter> {
  if (!cfg.anthropicApiKey) {
    throw new Error('Live mode requires ANTHROPIC_API_KEY (or set RESEARCH_MOCK=1)');
  }
  // Lazy-imported so mock-mode runs never load the SDK.
  const [{ default: Anthropic }, { createAnthropicAdapter }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('@harness-one/anthropic'),
  ]);
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  return createAnthropicAdapter({ client, model: cfg.model });
}

function defaultSearchProvider(cfg: EnvConfig): WebSearchProvider {
  const httpClient = nativeFetchClient();
  if (cfg.searchProvider === 'serpapi') {
    if (!cfg.serpapiApiKey) throw new Error('SERPAPI_API_KEY missing');
    return createSerpApiProvider({ apiKey: cfg.serpapiApiKey, httpClient });
  }
  if (cfg.searchProvider === 'brave') {
    if (!cfg.braveApiKey) throw new Error('BRAVE_SEARCH_API_KEY missing');
    return createBraveSearchProvider({ apiKey: cfg.braveApiKey, httpClient });
  }
  return createFixtureSearchProvider([]);
}

function defaultHttpFetcher(_cfg: EnvConfig): WebFetcher {
  return createHttpFetcher({ httpClient: nativeFetchClient() });
}
