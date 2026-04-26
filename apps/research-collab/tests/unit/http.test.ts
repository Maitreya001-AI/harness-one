import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nativeFetchClient } from '../../src/tools/http.js';

const ORIGINAL_FETCH = globalThis.fetch;

function makeStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const c = chunks[i++];
      if (c) controller.enqueue(c);
    },
  });
}

function makeResponse(body: string, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(body, init);
}

describe('nativeFetchClient', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('issues GET requests and reads the body', async () => {
    const fetchSpy = vi.fn(async () => makeResponse('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const client = nativeFetchClient();
    const res = await client.request({ url: 'https://x.example/' });
    expect(res.body).toBe('hello');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends body and method overrides', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url, init?: RequestInit) => {
      capturedInit = init;
      return makeResponse('ok');
    }) as typeof globalThis.fetch;
    const client = nativeFetchClient();
    await client.request({ url: 'https://x.example/', method: 'POST', body: 'payload' });
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.body).toBe('payload');
  });

  it('throws http_body_too_large when body exceeds the cap', async () => {
    // 5 MiB > 4 MiB cap
    const big = new Uint8Array(5 * 1024 * 1024);
    globalThis.fetch = (async () => {
      return new Response(makeStream([big]));
    }) as typeof globalThis.fetch;
    const client = nativeFetchClient();
    await expect(client.request({ url: 'https://x.example/' })).rejects.toThrow(/http_body_too_large/);
  });

  it('aborts if the upstream signal is already aborted', async () => {
    globalThis.fetch = (async (_url, init?: RequestInit) => {
      // The internal controller should already be aborted before fetch resolves.
      if (init?.signal?.aborted) {
        throw new Error('aborted-by-signal');
      }
      return makeResponse('ok');
    }) as typeof globalThis.fetch;
    const client = nativeFetchClient();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(client.request({ url: 'https://x.example/', signal: ctrl.signal })).rejects.toThrow();
  });

  it('aborts when timeout fires before the response', async () => {
    globalThis.fetch = (async (_url, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as typeof globalThis.fetch;
    const client = nativeFetchClient();
    await expect(client.request({ url: 'https://x.example/', timeoutMs: 5 })).rejects.toThrow(/aborted/);
  });

  it('handles a response with no body (e.g., 204)', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
    const client = nativeFetchClient();
    const res = await client.request({ url: 'https://x.example/' });
    expect(res.status).toBe(204);
    expect(res.body).toBe('');
  });
});
