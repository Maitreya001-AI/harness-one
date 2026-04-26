/**
 * Web search abstraction.
 *
 * Open Question 6 in DESIGN: pick external SaaS over a roll-our-own crawler.
 * We support SerpAPI (Google) and Brave Search out of the box because they're
 * the two most common keys teams have, and provide a fixture provider for
 * tests / CI / DOGFOOD-mode runs.
 *
 * Production callers swap the provider at construction time — `createHarness
 * Research` reads `RESEARCH_SEARCH_PROVIDER` and instantiates the matching
 * client.
 */

import { defineTool, toolError, toolSuccess, ToolCapability } from 'harness-one/tools';
import type { ToolDefinition } from 'harness-one/tools';

import { MAX_SEARCH_RESULTS } from '../config/defaults.js';

import type { HttpClient } from './http.js';

/** Single search-engine hit, normalised across providers. */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** Lowercase provider name so callers can attribute the hit. */
  readonly provider: string;
}

export interface SearchOptions {
  /** Maximum hits to return. Capped at {@link MAX_SEARCH_RESULTS}. */
  readonly limit?: number;
  /** AbortSignal cooperatively forwarded to the HTTP client. */
  readonly signal?: AbortSignal;
}

export interface WebSearchProvider {
  /** Lowercase identifier used in trace attrs and tool result attribution. */
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<readonly SearchHit[]>;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Fixture provider — used by tests and any run that lacks an API key.
 * ────────────────────────────────────────────────────────────────────────── */

export interface FixtureSearchEntry {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** Optional keyword set used to score relevance. Lowercased on use. */
  readonly keywords?: readonly string[];
}

/**
 * Deterministic provider that scores its in-memory corpus against the
 * incoming query. Ranking is intentionally simple: count of overlapping
 * lowercased tokens between query and (keywords ∪ title ∪ snippet).
 */
export function createFixtureSearchProvider(
  corpus: readonly FixtureSearchEntry[],
): WebSearchProvider {
  return {
    name: 'fixture',
    async search(query: string, options?: SearchOptions): Promise<readonly SearchHit[]> {
      const limit = clampLimit(options?.limit);
      const tokens = tokenize(query);
      if (tokens.length === 0 || corpus.length === 0) return [];

      const scored = corpus.map((entry) => {
        const entryTokens = new Set([
          ...(entry.keywords ?? []).flatMap((k) => tokenize(k)),
          ...tokenize(entry.title),
          ...tokenize(entry.snippet),
        ]);
        const overlap = tokens.reduce((acc, t) => acc + (entryTokens.has(t) ? 1 : 0), 0);
        return { entry, overlap };
      });

      scored.sort((a, b) => b.overlap - a.overlap);
      return scored
        .filter((s) => s.overlap > 0)
        .slice(0, limit)
        .map((s) => ({
          title: s.entry.title,
          url: s.entry.url,
          snippet: s.entry.snippet,
          provider: 'fixture',
        }));
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * SerpAPI provider (Google search).
 * ────────────────────────────────────────────────────────────────────────── */

interface SerpApiOrganicResult {
  readonly title?: string;
  readonly link?: string;
  readonly snippet?: string;
}

interface SerpApiResponse {
  readonly organic_results?: readonly SerpApiOrganicResult[];
  readonly error?: string;
}

export interface SerpApiProviderOptions {
  readonly apiKey: string;
  /** Override the HTTP client. Mostly used by tests. */
  readonly httpClient: HttpClient;
  /** Override the base URL for self-hosted relays. Defaults to the SerpAPI hosted endpoint. */
  readonly baseUrl?: string;
}

export function createSerpApiProvider(options: SerpApiProviderOptions): WebSearchProvider {
  const baseUrl = options.baseUrl ?? 'https://serpapi.com/search.json';
  return {
    name: 'serpapi',
    async search(query: string, opts?: SearchOptions): Promise<readonly SearchHit[]> {
      const limit = clampLimit(opts?.limit);
      const url = new URL(baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('api_key', options.apiKey);
      url.searchParams.set('engine', 'google');
      url.searchParams.set('num', String(limit));

      const requestPayload: { url: string; method: 'GET'; signal?: AbortSignal } = {
        url: url.toString(),
        method: 'GET',
      };
      if (opts?.signal !== undefined) requestPayload.signal = opts.signal;
      const res = await options.httpClient.request(requestPayload);
      if (res.status >= 400) {
        throw new Error(`serpapi http ${res.status}`);
      }
      const parsed = parseJson<SerpApiResponse>(res.body);
      if (parsed.error) {
        throw new Error(`serpapi error: ${parsed.error}`);
      }
      const results = parsed.organic_results ?? [];
      return results
        .map((r) => normaliseHit(r.title, r.link, r.snippet, 'serpapi'))
        .filter((h): h is SearchHit => h !== undefined)
        .slice(0, limit);
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Brave Search provider.
 * ────────────────────────────────────────────────────────────────────────── */

interface BraveResult {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string;
}

interface BraveResponse {
  readonly web?: { readonly results?: readonly BraveResult[] };
  readonly message?: string;
}

export interface BraveSearchProviderOptions {
  readonly apiKey: string;
  readonly httpClient: HttpClient;
  readonly baseUrl?: string;
}

export function createBraveSearchProvider(options: BraveSearchProviderOptions): WebSearchProvider {
  const baseUrl = options.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search';
  return {
    name: 'brave',
    async search(query: string, opts?: SearchOptions): Promise<readonly SearchHit[]> {
      const limit = clampLimit(opts?.limit);
      const url = new URL(baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(limit));

      const requestPayload: {
        url: string;
        method: 'GET';
        headers: Record<string, string>;
        signal?: AbortSignal;
      } = {
        url: url.toString(),
        method: 'GET',
        headers: {
          'X-Subscription-Token': options.apiKey,
          accept: 'application/json',
        },
      };
      if (opts?.signal !== undefined) requestPayload.signal = opts.signal;
      const res = await options.httpClient.request(requestPayload);
      if (res.status >= 400) {
        throw new Error(`brave http ${res.status}`);
      }
      const parsed = parseJson<BraveResponse>(res.body);
      if (parsed.message && !parsed.web) {
        throw new Error(`brave error: ${parsed.message}`);
      }
      const hits = parsed.web?.results ?? [];
      return hits
        .map((r) => normaliseHit(r.title, r.url, r.description, 'brave'))
        .filter((h): h is SearchHit => h !== undefined)
        .slice(0, limit);
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tool definition consumable by harness-one tools registry.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the harness-one `web_search` tool around any {@link WebSearchProvider}.
 * The tool surface is identical regardless of provider so the Specialist
 * agent only sees one schema.
 */
export function defineWebSearchTool(
  provider: WebSearchProvider,
): ToolDefinition<{ query: string; limit?: number }> {
  return defineTool<{ query: string; limit?: number }>({
    name: 'web_search',
    description:
      'Run a search-engine query and return up to `limit` hits (title, url, snippet). ' +
      'Use this to find candidate sources before calling web_fetch on the most promising URL.',
    // Truthful capability declaration — readonly from the agent's POV
    // (no remote mutation) but the call leaves the workspace via the
    // search-engine API. The harness-factory explicitly allows
    // `network` via HarnessConfigBase.tools.allowedCapabilities so
    // the truthful declaration sticks. Closes HARNESS_LOG L-001.
    capabilities: [ToolCapability.Readonly, ToolCapability.Network],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search-engine query string. Keep it focused on the subquestion.',
          minLength: 1,
        },
        limit: {
          type: 'integer',
          description: `Max number of hits (1..${MAX_SEARCH_RESULTS}).`,
          minimum: 1,
          maximum: MAX_SEARCH_RESULTS,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(params, signal) {
      try {
        const opts: SearchOptions = {
          ...(params.limit !== undefined && { limit: params.limit }),
          ...(signal !== undefined && { signal }),
        };
        const hits = await provider.search(params.query, opts);
        return toolSuccess({
          provider: provider.name,
          query: params.query,
          results: hits,
        });
      } catch (err) {
        return toolError(
          `web_search failed: ${err instanceof Error ? err.message : String(err)}`,
          'internal',
          'Retry with a refined query; provider may be rate-limited.',
          true,
        );
      }
    },
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers (module-private).
 * ────────────────────────────────────────────────────────────────────────── */

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_SEARCH_RESULTS;
  if (!Number.isInteger(limit) || limit < 1) return 1;
  if (limit > MAX_SEARCH_RESULTS) return MAX_SEARCH_RESULTS;
  return limit;
}

function normaliseHit(
  title: string | undefined,
  url: string | undefined,
  snippet: string | undefined,
  provider: string,
): SearchHit | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  if (!/^https?:\/\//i.test(url)) return undefined;
  return {
    title: typeof title === 'string' ? title.slice(0, 300) : url,
    url,
    snippet: typeof snippet === 'string' ? snippet.slice(0, 600) : '',
    provider,
  };
}

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    throw new Error(`invalid JSON from search provider: ${(err as Error).message}`);
  }
}
