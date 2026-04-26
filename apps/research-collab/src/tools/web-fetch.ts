/**
 * Web-fetch tool.
 *
 * Fetches a URL, sanitizes the HTML, and runs the result through the
 * web-content guardrail. The Specialist agent calls this after `web_search`
 * narrows down a candidate URL.
 *
 * Defensive defaults:
 * - Only http/https URLs accepted (no file:// / data:// / SSRF-style schemes).
 * - 64 KiB output cap so a single page can't blow the agent context.
 * - Guardrail block returns a tool error the LLM can see — no silent allow.
 */

import { defineTool, toolError, toolSuccess, ToolCapability } from 'harness-one/tools';
import type { ToolDefinition } from 'harness-one/tools';

import { MAX_FETCH_BYTES } from '../config/defaults.js';
import { createWebContentGuardrail, type WebContentGuardrail } from '../guardrails/web-content.js';

import type { HttpClient } from './http.js';
import { sanitizeHtml } from './sanitize.js';

export interface FetchedPage {
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly bytes: number;
}

export interface WebFetcher {
  fetch(url: string, options?: { signal?: AbortSignal }): Promise<FetchedPage>;
}

export interface HttpFetcherOptions {
  readonly httpClient: HttpClient;
  readonly maxBytes?: number;
  readonly userAgent?: string;
}

const DEFAULT_USER_AGENT = 'harness-one-research-collab/0.1 (+https://github.com/Maitreya001-AI/harness-one)';

/**
 * `WebFetcher` backed by an HttpClient + HTML sanitizer.
 *
 * Returns a normalised page object even when the upstream content-type is
 * not `text/html` (we still strip tags to handle `application/xhtml+xml` and
 * mis-labelled responses).
 */
export function createHttpFetcher(options: HttpFetcherOptions): WebFetcher {
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
  return {
    async fetch(url: string, opts?: { signal?: AbortSignal }): Promise<FetchedPage> {
      assertHttpUrl(url);
      const reqHeaders: Record<string, string> = {
        'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
        accept: 'text/html, text/plain, application/xhtml+xml',
      };
      const requestPayload: {
        url: string;
        method: 'GET';
        headers: Record<string, string>;
        signal?: AbortSignal;
      } = {
        url,
        method: 'GET',
        headers: reqHeaders,
      };
      if (opts?.signal !== undefined) requestPayload.signal = opts.signal;
      const res = await options.httpClient.request(requestPayload);
      if (res.status >= 400) {
        throw new Error(`web_fetch http ${res.status} for ${url}`);
      }
      const sanitized = sanitizeHtml(res.body, maxBytes);
      return {
        url: res.url || url,
        title: sanitized.title,
        content: sanitized.text,
        bytes: new TextEncoder().encode(sanitized.text).byteLength,
      };
    },
  };
}

/** Test helper that returns canned pages keyed by URL. */
export function createFixtureFetcher(
  pages: ReadonlyMap<string, FetchedPage>,
): WebFetcher {
  return {
    async fetch(url: string): Promise<FetchedPage> {
      assertHttpUrl(url);
      const hit = pages.get(url);
      if (!hit) throw new Error(`fixture: no page registered for ${url}`);
      return hit;
    },
  };
}

export interface DefineWebFetchToolOptions {
  readonly fetcher: WebFetcher;
  readonly guardrail?: WebContentGuardrail;
}

export function defineWebFetchTool(
  options: DefineWebFetchToolOptions,
): ToolDefinition<{ url: string }> {
  const guardrail = options.guardrail ?? createWebContentGuardrail();
  return defineTool<{ url: string }>({
    name: 'web_fetch',
    description:
      'Download a single https:// URL, return its sanitized text body and best-effort title. ' +
      'Always run a guardrail check on the returned content before quoting it.',
    // Readonly from the agent's POV — fetches a remote document but never
    // mutates remote state. Same convention as web_search above.
    capabilities: [ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute https://... URL of the page to fetch.',
          minLength: 8,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(params, signal) {
      try {
        const fetchOpts: { signal?: AbortSignal } = {};
        if (signal !== undefined) fetchOpts.signal = signal;
        const page = await options.fetcher.fetch(params.url, fetchOpts);
        const verdict = guardrail.inspect(page.content, `web_fetch:${page.url}`);
        if (verdict.action === 'block') {
          return toolError(
            `web_fetch blocked by guardrail: ${verdict.reason ?? 'injection suspected'}`,
            'permission',
            'Choose a different URL or reformulate the subquestion to avoid this source.',
            false,
          );
        }
        return toolSuccess(page);
      } catch (err) {
        return toolError(
          `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          'internal',
          'Pick another URL or refine the search query before retrying.',
          true,
        );
      }
    },
  });
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`web_fetch: not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`web_fetch: only http/https accepted, got ${parsed.protocol}`);
  }
}
