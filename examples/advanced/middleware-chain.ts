/**
 * Example: `createMiddlewareChain` — onion-style cross-cutting concerns.
 *
 * Wraps adapter calls / tool execution with retry, timing, auth, caching,
 * circuit-breakers — without touching the primitives themselves. Execution
 * order is registration order (Set-backed; duplicate registrations dedupe).
 *
 * Pair with:
 *   - `Harness.middleware` from `@harness-one/preset` (pre-wired chain)
 *   - `ToolDefinition.middleware` from `harness-one/tools` (per-tool onion)
 */
import { createMiddlewareChain } from 'harness-one/advanced';
import { createMockAdapter } from 'harness-one/advanced';
import type { MiddlewareFn } from 'harness-one/advanced';

async function main(): Promise<void> {
  const chain = createMiddlewareChain({
    onError: (err, ctx) => console.error(`[middleware:${ctx.type}]`, err.message),
  });

  // ── Middleware 1: timing ────────────────────────────────────────────────
  const withTiming: MiddlewareFn = async (ctx, next) => {
    const t0 = Date.now();
    try {
      return await next();
    } finally {
      console.log(`[${ctx.type}] ${Date.now() - t0}ms`);
    }
  };

  // ── Middleware 2: retry with exponential backoff ────────────────────────
  const withRetry: MiddlewareFn = async (ctx, next) => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await next();
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        const backoff = 2 ** (attempt - 1) * 100; // 100 / 200 / 400 ms
        console.log(`[${ctx.type}] retry ${attempt} after ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw new Error('unreachable');
  };

  // ── Middleware 3: structured logging ────────────────────────────────────
  const withLogging: MiddlewareFn = async (ctx, next) => {
    console.log(`[${ctx.type}] start`);
    const result = await next();
    console.log(`[${ctx.type}] ok`);
    return result;
  };

  // Registration order = outer → inner. `withTiming` wraps everything.
  const unsubTiming = chain.use(withTiming);
  chain.use(withRetry);
  chain.use(withLogging);

  // ── Example 1: wrap an adapter.chat() call ───────────────────────────────
  const adapter = createMockAdapter({
    responses: [{ content: 'Hello from mock adapter!' }],
  });
  const result = await chain.execute(
    { type: 'chat' as const },
    () => adapter.chat({ messages: [{ role: 'user', content: 'hi' }] }),
  );
  console.log('Result:', result);

  // ── Example 2: unsubscribe removes one middleware without re-building ──
  unsubTiming();
  await chain.execute({ type: 'tool_call' }, async () => {
    console.log('[handler] executing tool…');
    return { ok: true };
  });

  // ── Example 3: clear everything (tests use this between cases) ──────────
  chain.clear();
  const raw = await chain.execute({ type: 'chat' }, async () => 'no middleware');
  console.log('After clear:', raw);
}

main().catch(console.error);
