import { describe, expect, it } from 'vitest';

import {
  createBraveSearchProvider,
  createFixtureSearchProvider,
  createSerpApiProvider,
  defineWebSearchTool,
  type FixtureSearchEntry,
} from '../../src/tools/web-search.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../../src/tools/http.js';
import { MAX_SEARCH_RESULTS } from '../../src/config/defaults.js';

const FIXTURE_CORPUS: FixtureSearchEntry[] = [
  {
    title: 'LangGraph state machines',
    url: 'https://x.example/langgraph',
    snippet: 'LangGraph orchestrates agent state.',
    keywords: ['langgraph', 'state'],
  },
  {
    title: 'Mastra workflows',
    url: 'https://x.example/mastra',
    snippet: 'Mastra is a workflow engine for agents.',
    keywords: ['mastra', 'workflow'],
  },
  {
    title: 'Unrelated astronomy article',
    url: 'https://x.example/astro',
    snippet: 'Mars rover finds water.',
    keywords: ['mars', 'water'],
  },
];

function stubHttp(handler: (req: HttpRequest) => Partial<HttpResponse> | Promise<Partial<HttpResponse>>): HttpClient {
  return {
    async request(req) {
      const partial = await handler(req);
      return {
        status: 200,
        url: req.url,
        headers: {},
        body: '',
        ...partial,
      };
    },
  };
}

describe('createFixtureSearchProvider', () => {
  it('returns ranked hits from the corpus', async () => {
    const provider = createFixtureSearchProvider(FIXTURE_CORPUS);
    const hits = await provider.search('LangGraph workflow');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.url).toBe('https://x.example/langgraph');
  });

  it('returns empty when no overlap', async () => {
    const provider = createFixtureSearchProvider(FIXTURE_CORPUS);
    const hits = await provider.search('quantum chromodynamics');
    expect(hits).toEqual([]);
  });

  it('returns empty for whitespace-only query', async () => {
    const provider = createFixtureSearchProvider(FIXTURE_CORPUS);
    expect(await provider.search('   ')).toEqual([]);
  });

  it('returns empty when corpus is empty', async () => {
    const provider = createFixtureSearchProvider([]);
    expect(await provider.search('anything')).toEqual([]);
  });

  it('honours the limit option', async () => {
    const provider = createFixtureSearchProvider(FIXTURE_CORPUS);
    const hits = await provider.search('mastra langgraph mars', { limit: 1 });
    expect(hits).toHaveLength(1);
  });

  it('clamps absurd limits', async () => {
    const provider = createFixtureSearchProvider(FIXTURE_CORPUS);
    const hits = await provider.search('mastra langgraph mars', { limit: 999 });
    expect(hits.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
  });
});

describe('createSerpApiProvider', () => {
  it('parses organic_results into SearchHit shape', async () => {
    const http = stubHttp(() => ({
      status: 200,
      body: JSON.stringify({
        organic_results: [
          { title: 'A', link: 'https://a.example', snippet: 's' },
          { title: 'B', link: 'https://b.example', snippet: 't' },
        ],
      }),
    }));
    const provider = createSerpApiProvider({ apiKey: 'k', httpClient: http });
    const hits = await provider.search('q');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.provider).toBe('serpapi');
  });

  it('throws on http error status', async () => {
    const http = stubHttp(() => ({ status: 500 }));
    const provider = createSerpApiProvider({ apiKey: 'k', httpClient: http });
    await expect(provider.search('q')).rejects.toThrow(/serpapi http 500/);
  });

  it('throws on api-level error payload', async () => {
    const http = stubHttp(() => ({ body: JSON.stringify({ error: 'bad key' }) }));
    const provider = createSerpApiProvider({ apiKey: 'k', httpClient: http });
    await expect(provider.search('q')).rejects.toThrow(/serpapi error/);
  });

  it('drops malformed result entries', async () => {
    const http = stubHttp(() => ({
      body: JSON.stringify({
        organic_results: [
          { title: 'A' }, // missing link
          { title: 'B', link: 'ftp://b' }, // bad scheme
          { title: 'C', link: 'https://c.example', snippet: 's' },
        ],
      }),
    }));
    const provider = createSerpApiProvider({ apiKey: 'k', httpClient: http });
    const hits = await provider.search('q');
    expect(hits.map((h) => h.url)).toEqual(['https://c.example']);
  });

  it('throws on invalid JSON body', async () => {
    const http = stubHttp(() => ({ body: 'not json' }));
    const provider = createSerpApiProvider({ apiKey: 'k', httpClient: http });
    await expect(provider.search('q')).rejects.toThrow(/invalid JSON/);
  });

  it('forwards limit and abort signal', async () => {
    let observed: HttpRequest | undefined;
    const http: HttpClient = {
      async request(req) {
        observed = req;
        return { status: 200, body: '{}', url: req.url, headers: {} };
      },
    };
    const provider = createSerpApiProvider({ apiKey: 'k', httpClient: http });
    const ctrl = new AbortController();
    await provider.search('q', { limit: 2, signal: ctrl.signal });
    expect(observed?.url).toContain('num=2');
    expect(observed?.signal).toBe(ctrl.signal);
  });
});

describe('createBraveSearchProvider', () => {
  it('parses web.results into SearchHit shape', async () => {
    const http = stubHttp(() => ({
      body: JSON.stringify({
        web: { results: [{ title: 'X', url: 'https://x.example', description: 'd' }] },
      }),
    }));
    const provider = createBraveSearchProvider({ apiKey: 'k', httpClient: http });
    const hits = await provider.search('q');
    expect(hits[0]?.provider).toBe('brave');
  });

  it('throws on http error', async () => {
    const http = stubHttp(() => ({ status: 401 }));
    const provider = createBraveSearchProvider({ apiKey: 'k', httpClient: http });
    await expect(provider.search('q')).rejects.toThrow(/brave http 401/);
  });

  it('throws on api-level error payload', async () => {
    const http = stubHttp(() => ({ body: JSON.stringify({ message: 'rate limited' }) }));
    const provider = createBraveSearchProvider({ apiKey: 'k', httpClient: http });
    await expect(provider.search('q')).rejects.toThrow(/brave error/);
  });

  it('forwards subscription token header', async () => {
    let observed: HttpRequest | undefined;
    const http: HttpClient = {
      async request(req) {
        observed = req;
        return { status: 200, body: '{}', url: req.url, headers: {} };
      },
    };
    const provider = createBraveSearchProvider({ apiKey: 'token', httpClient: http });
    await provider.search('q');
    expect(observed?.headers?.['X-Subscription-Token']).toBe('token');
  });
});

describe('defineWebSearchTool', () => {
  it('returns success result with hits', async () => {
    const provider = createFixtureSearchProvider(FIXTURE_CORPUS);
    const tool = defineWebSearchTool(provider);
    const res = await tool.execute({ query: 'langgraph' });
    expect(res.success).toBe(true);
    if (res.success) {
      const data = res.data as { results: unknown[] };
      expect(Array.isArray(data.results)).toBe(true);
    }
  });

  it('returns error result on provider throw', async () => {
    const provider = {
      name: 'broken',
      async search() {
        throw new Error('upstream gone');
      },
    };
    const tool = defineWebSearchTool(provider);
    const res = await tool.execute({ query: 'q' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.message).toContain('upstream gone');
    }
  });

  it('passes signal through to the provider', async () => {
    let observedSignal: AbortSignal | undefined;
    const provider = {
      name: 'capture',
      async search(_q: string, opts?: { signal?: AbortSignal }) {
        observedSignal = opts?.signal;
        return [];
      },
    };
    const tool = defineWebSearchTool(provider);
    const ctrl = new AbortController();
    await tool.execute({ query: 'q' }, ctrl.signal);
    expect(observedSignal).toBe(ctrl.signal);
  });
});
