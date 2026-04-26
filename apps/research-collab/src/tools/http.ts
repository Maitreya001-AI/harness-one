/**
 * Tiny HTTP client abstraction.
 *
 * The whole research-collab tool layer talks to the network through this
 * interface so tests can inject a deterministic stub. Production callers fall
 * back to {@link nativeFetchClient}, which thinly wraps Node 22's global
 * `fetch`.
 *
 * Kept intentionally minimal — request method, URL, optional headers + body
 * + timeout. Anything more elaborate (streaming bodies, retries, cookies)
 * belongs in a dedicated module so this surface stays test-mockable in one
 * line.
 */

export interface HttpRequest {
  readonly method?: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** Per-request timeout in ms; defaults to 15s when omitted. */
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MiB hard cap on raw body

/**
 * `HttpClient` backed by Node's global `fetch`.
 *
 * Enforces:
 * - per-request timeout via `AbortController` linked to the caller's signal
 * - 4 MiB body cap so a server returning a multi-GB stream can't OOM the agent
 *
 * Throws `Error('http_timeout')` on timeout, `Error('http_body_too_large')` on
 * cap breach. Caller-supplied `AbortSignal` is honoured (treated as cancel).
 */
export function nativeFetchClient(): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('http_timeout')), timeoutMs);

      const upstreamSignal = req.signal;
      const onUpstreamAbort = (): void => {
        controller.abort(upstreamSignal?.reason ?? new Error('aborted'));
      };
      if (upstreamSignal) {
        if (upstreamSignal.aborted) {
          onUpstreamAbort();
        } else {
          upstreamSignal.addEventListener('abort', onUpstreamAbort, { once: true });
        }
      }

      try {
        const init: RequestInit = {
          method: req.method ?? 'GET',
          signal: controller.signal,
          ...(req.headers !== undefined && { headers: req.headers as Record<string, string> }),
          ...(req.body !== undefined && { body: req.body }),
        };
        const res = await globalThis.fetch(req.url, init);

        // Stream the body with a hard byte cap so an attacker-controlled
        // server can't push gigabytes of HTML into agent memory.
        const reader = res.body?.getReader();
        let total = 0;
        const chunks: Uint8Array[] = [];
        if (reader) {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              total += value.byteLength;
              if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error('http_body_too_large');
              }
              chunks.push(value);
            }
          }
        }

        const buf = concatChunks(chunks);
        const body = new TextDecoder('utf-8', { fatal: false }).decode(buf);

        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });

        return { status: res.status, url: res.url, headers, body };
      } finally {
        clearTimeout(timer);
        if (upstreamSignal) {
          upstreamSignal.removeEventListener('abort', onUpstreamAbort);
        }
      }
    },
  };
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
