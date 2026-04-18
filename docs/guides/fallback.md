# Fallback Adapter — Failure Modes & Recovery

`createFallbackAdapter` is a small circuit breaker that wraps an ordered list of `AgentAdapter` instances. It is the single supported mechanism for surviving a primary-provider outage without rewriting your agent loop.

```ts
// createFallbackAdapter / categorizeAdapterError live on the /advanced
// subpath — they're extension-author primitives, not part of the curated
// root barrel.
import { createFallbackAdapter } from 'harness-one/advanced';

const adapter = createFallbackAdapter({
  adapters: [primaryAdapter, backupAdapter],
  maxFailures: 3,
});
```

## What counts as a failure

Any thrown error from the current adapter's `chat()` or `stream()`. harness-one classifies errors via `categorizeAdapterError()` from `harness-one/advanced`:

| Category | Trigger (error message contains) | Typical cause |
|----------|-----------------------------------|---------------|
| `ADAPTER_RATE_LIMIT` | `rate`, `429`, `too many` | Provider throttling |
| `ADAPTER_AUTH`       | `auth`, `401`, `api key`, `unauthorized` | Bad / expired key |
| `ADAPTER_UNAVAILABLE`| `5xx`, `bad gateway`, `service unavailable`, `gateway timeout` | Transient upstream outage |
| `ADAPTER_NETWORK`    | `timeout`, `econnrefused`, `network`, `fetch` | Transient network |
| `ADAPTER_PARSE`      | `parse`, `json`, `malformed` | Corrupt stream chunk |
| `ADAPTER_ERROR`      | (fallback) | Unclassified |

**All** of these count against `maxFailures` equally — the breaker does not treat auth errors as non-retryable. Guard against obviously terminal errors (e.g. invalid API key) yourself before wiring them into the fallback.

Note: AgentLoop's default `retryableErrors` is `['ADAPTER_RATE_LIMIT']` only —
`ADAPTER_UNAVAILABLE` / `ADAPTER_NETWORK` are categorized but **not** retried
unless you opt in via `AgentLoopConfig.retryableErrors`. The fallback adapter
sits **outside** that retry loop and advances on any error regardless of the
retryable set.

## Switch behavior

- After `maxFailures` **consecutive** failures on the current adapter, the breaker advances `currentIndex` to the next adapter and resets the counter.
- A single success anywhere resets the counter to 0.
- When the last adapter also fails past the threshold, the error is rethrown (not wrapped). The original error reaches your caller so existing retry logic continues to work.
- The switch is protected by a mutex: concurrent callers that trip the threshold simultaneously only cause one advance, never double-advance.

## How to log switches

There is **no `adapter_switched` event** on `AgentLoop` today. Detect switches explicitly:

```ts
import { categorizeAdapterError } from 'harness-one/advanced';

function loggedAdapter(inner, label, logger) {
  return {
    name: inner.name,
    async chat(params) {
      try { return await inner.chat(params); }
      catch (err) {
        logger.warn(`${label} failed`, { code: categorizeAdapterError(err) });
        throw err;
      }
    },
  };
}

const adapter = createFallbackAdapter({
  adapters: [loggedAdapter(primary, 'primary', logger), backup],
  maxFailures: 3,
});
```

Wrapping each inner adapter gives you one log line per attempt, letting you reconstruct the switch timeline in your trace backend. See `examples/observe/error-handling.ts` for a full demo.

## Recovery strategies

**Periodic reset.** The breaker does not auto-recover to the primary. If you want to re-try the primary after the incident clears, dispose the current fallback and build a new one on a timer:

```ts
let adapter = createFallbackAdapter({ adapters: [primary, backup] });
setInterval(() => {
  adapter = createFallbackAdapter({ adapters: [primary, backup] });
}, 5 * 60_000);
```

**Active health check.** Run a lightweight probe (`adapter.chat({ messages: [{ role:'user', content:'ping' }] })`) against the primary every N seconds and swap the live reference when it succeeds again. This keeps the primary cold-start latency out of the user path.

**Graceful degradation.** Put a cheaper model in slot 2, not a redundant copy of the same one — if the primary is failing, a same-provider fallback is often failing too.

## Common pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Putting the same provider twice | Both fail together during an outage | Use a different provider or a local/cached adapter |
| `maxFailures: 1` in production | Single transient error flips the breaker | Keep the default `3` unless you have strong evidence for faster switching |
| Forgetting streaming support | `STREAM_NOT_SUPPORTED` on the backup | Ensure every slot implements `stream?()` if your loop calls it |
| Expecting permanent recovery | Primary recovers, breaker never switches back | Use the periodic-reset pattern above |
| Classifying on `.code` | All errors fall into `ADAPTER_ERROR` | `categorizeAdapterError()` inspects `err.message`, not `.code` |

## Related

- `packages/core/src/core/fallback-adapter.ts` — implementation
- `packages/core/src/core/error-classifier.ts` — classification table
- `examples/observe/error-handling.ts` — end-to-end runnable demo
- `docs/architecture/01-core.md` — AgentLoop + resilience wiring
