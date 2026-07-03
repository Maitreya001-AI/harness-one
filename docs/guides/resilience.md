# Resilience — Which Mechanism, and How They Compose

harness-one ships **four** resilience mechanisms that overlap enough to be
confusing. They operate at different layers, recover from different failures,
and stack in a specific order. This guide is the selection story: pick the
right one for your symptom, then compose them without amplifying load or
blowing your token budget.

| # | Mechanism | Layer | Recovers from | Auto-recovers? |
|---|-----------|-------|---------------|----------------|
| 1 | **In-loop adapter retry** (`AgentLoopConfig`) | inside one iteration | transient same-provider blips | n/a (retries in place) |
| 2 | **Fallback adapter** (`createFallbackAdapter`) | the adapter you hand the loop | a whole provider going down | **no** — one-way |
| 3 | **Resilient loop** (`createResilientLoop`) | wraps the whole `AgentLoop` | a run that went off the rails | yes (fresh re-run) |
| 4 | **Circuit breaker** (`createCircuitBreaker`) | around any downstream call | a persistently-failing dependency | **yes** — half-open probe |

---

## Decision table — start here

| Symptom / goal | Reach for | Why |
|----------------|-----------|-----|
| Occasional `429` / rate-limit / a flaky socket to the **same** provider | **In-loop retry** (`maxAdapterRetries`) | Retries the exact call in place with backoff; the conversation is untouched. |
| Your **primary provider** has an outage and you have a second provider (or a cheaper/local model) to fall back to | **Fallback adapter** | Fails over to the next adapter after N consecutive failures. Survives a provider-wide incident. |
| A long autonomous run **poisons its own context** — loops on `max_iterations`, blows the token budget, or dies mid-task | **Resilient loop** | Re-runs a *fresh* `AgentLoop` with a summarized plan, dropping the degenerate context. |
| You need to **protect a downstream dependency** (a tool's HTTP API, a vector DB, an internal service) from cascading failure | **Circuit breaker** | Fast-fails while the dependency is down instead of piling on load; auto-probes for recovery. |
| A transient blip that in-loop retry already covers | *nothing extra* | Don't stack mechanisms for a failure one layer already handles. |

If two rows apply, you probably want to **compose** them — see
[Composition rules](#composition-rules). If you're unsure, the
[production default recipe](#start-here-the-production-default-recipe) is a
safe baseline.

---

## The four mechanisms in detail

### 1. In-loop adapter retry — transient same-provider blips

Three fields on `AgentLoopConfig` (root `harness-one` / `harness-one/core`):

```ts
const loop = new AgentLoop({
  adapter,
  maxAdapterRetries: 2,                 // default: 0 (OFF)
  baseRetryDelayMs: 1000,               // default: 1000
  retryableErrors: ['ADAPTER_RATE_LIMIT'], // default: ['ADAPTER_RATE_LIMIT']
});
```

- **Off by default.** `maxAdapterRetries` defaults to `0` — you get *one*
  attempt unless you opt in.
- **Retryable set is narrow by default.** Only `ADAPTER_RATE_LIMIT` retries.
  `ADAPTER_NETWORK`, `ADAPTER_UNAVAILABLE`, etc. are *categorized* but **not**
  retried unless you add them to `retryableErrors`. (Auth errors are never
  retryable — the same key fails the same way.)
- **Backoff.** `min(baseRetryDelayMs · 2^attempt, 10_000) · (0.75 + 0.25·rand)`
  — exponential, capped at 10 s, with 25 % jitter to de-synchronise concurrent
  clients. The backoff sleep honours the loop's `AbortSignal`.
- **Total attempts per iteration** = `maxAdapterRetries + 1`.
- **Scope:** same provider, same conversation, same iteration. It cannot save
  you from a provider that is fully down — for that, see the fallback adapter.

See the retry-knob TSDoc in
[`agent-loop-types.ts`](../../packages/core/src/core/agent-loop-types.ts).

### 2. Fallback adapter — provider outage

`createFallbackAdapter` (from `harness-one/advanced`) wraps an ordered list of
adapters and hands you back a single `AgentAdapter` you pass to the loop.

```ts
import { createFallbackAdapter } from 'harness-one/advanced';

const adapter = createFallbackAdapter({
  adapters: [primary, backup],   // first is primary
  maxFailures: 3,                // default: 3
});
const loop = new AgentLoop({ adapter });
```

- **One-way breaker.** After `maxFailures` **consecutive** failures on the
  current adapter it advances to the next and **never comes back** to the
  primary on its own. A single success resets the failure *counter* but leaves
  you on the degraded adapter.
- **Every error counts equally.** Unlike in-loop retry, the fallback does not
  consult `retryableErrors` — auth errors advance the breaker just like
  rate-limits. Filter obviously-terminal errors before wiring them in.
- **A single `chat()` call makes at most `adapters.length` attempts** (bounded
  loop, never recursive). This interacts with `maxFailures` — see the
  [warning below](#interaction-warnings).
- When the *last* adapter fails past threshold, the original error is rethrown
  (not wrapped).

Deep dive, logging patterns, and recovery strategies:
[`fallback.md`](./fallback.md). Runnable example:
[`examples/resilience/fallback-adapter.ts`](../../examples/resilience/fallback-adapter.ts).

### 3. Resilient loop — the run went off the rails

`createResilientLoop` (from `harness-one/advanced`) wraps an entire `AgentLoop`
and re-runs it from a **fresh context** when the inner run terminates badly.

```ts
import { createResilientLoop } from 'harness-one/advanced';

const resilient = createResilientLoop({
  loopConfig: { adapter, maxIterations: 20, maxTotalTokens: 100_000 },
  maxOuterRetries: 2,            // default: 2
  onRetry: async ({ attempt, reason, conversationSoFar }) => ({
    summary: await summarize(conversationSoFar), // compress progress
  }),
});
```

- **Retries on degenerate `DoneReason`s:** `max_iterations`, `token_budget`,
  and `error`. It does **not** retry `end_turn` (normal completion) or
  `aborted` (user signal).
- **Fresh context per attempt.** Each retry constructs a *new* `AgentLoop` and
  **replaces the conversation** with `[system(summary), ...additionalMessages]`
  from your `onRetry`. Iteration counters, token budget, and in-flight tool
  state all reset — it does **not** resume mid-conversation. This is the whole
  point: shed the poisoned context.
- **`onRetry` is what makes it useful.** *Without* an `onRetry` callback it
  re-runs the **original** messages verbatim — which re-enters the same
  degenerate state. Always provide a summarizer.
- Each inner loop is disposed between attempts. Total inner runs =
  `maxOuterRetries + 1`.

Runnable example:
[`examples/advanced/resilient-loop.ts`](../../examples/advanced/resilient-loop.ts).

### 4. Circuit breaker — protect a downstream dependency

`createCircuitBreaker`
([`infra/circuit-breaker.ts`](../../packages/core/src/infra/circuit-breaker.ts))
is a general-purpose breaker for wrapping **any** async call — a tool's HTTP
endpoint, a vector store, an internal service — not just LLM adapters.

```ts
const cb = createCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });
const result = await cb.execute(() => downstream.call());
```

- **State machine:** `closed` → (`failureThreshold` consecutive failures) →
  `open` → (`resetTimeoutMs` elapsed) → `half_open` → success closes it,
  failure re-opens it. `half_open` admits **one** probe at a time.
- **Auto-recovers.** This is the key contrast with the fallback adapter: the
  breaker actively probes and closes itself again once the dependency heals.
  The fallback's one-way breaker does not.
- Defaults: `failureThreshold: 5`, `resetTimeoutMs: 30_000`. Surface
  transitions via the `onStateChange` callback for metrics/alerting.

> ⚠️ **Wiring caveat.** `createCircuitBreaker` / `CircuitOpenError` are
> exported from **`harness-one/advanced`**, but the breaker is deliberately
> **not wired into `AgentLoopConfig`** — `createAgentLoop` never constructs
> one. To circuit-break an LLM provider *through the loop* you rely on the
> fallback adapter (or a custom adapter that composes `createCircuitBreaker`
> around its own calls). Use the breaker directly for **downstream
> dependencies you call yourself** (typically inside tool handlers), where
> `cb.execute()` is fully in your control. `ADAPTER_CIRCUIT_OPEN` /
> `CircuitOpenError` only fire when a breaker is actually wired in.

---

## Composition rules

The mechanisms nest. Outermost to innermost, for **one user request**:

```
resilient loop            ← re-runs everything with fresh context
  └─ AgentLoop.run()      ← up to maxIterations iterations
       └─ in-loop retry   ← per iteration: maxAdapterRetries+1 attempts
            └─ fallback adapter.chat()   ← walks the adapter chain
                 └─ (breaker around a provider, if you compose one)
                      └─ actual provider call
```

Rules that follow from this nesting:

1. **The resilient loop wraps everything.** It re-runs a whole `AgentLoop`, so
   every inner mechanism resets on each outer attempt.
2. **In-loop retry sits *outside* the fallback adapter, not inside it.** You
   hand the *composed fallback* to the loop, so each retry attempt is one
   `fallbackAdapter.chat()` call. A retryable error therefore both (a) triggers
   an in-loop retry **and** (b) counts toward the fallback's failure threshold.
3. **To get "retries exhaust against one provider *before* failover," retry
   per-provider — not via `maxAdapterRetries`.** Wrap **each** provider adapter
   in its own retry (or breaker) decorator, *then* compose those into the
   fallback. harness-one's built-in in-loop retry only sees the composed
   fallback, never the individual providers, so it can't scope retries
   per-provider by itself. (`examples/advanced/middleware-chain.ts` shows the
   per-adapter decorator shape.)
4. **The circuit breaker sits innermost**, around a single dependency's calls.
   Put it *inside* an adapter or a tool handler — the thing you're protecting.

### Interaction warnings

**Retry × rate-limit amplification.** Retrying `ADAPTER_RATE_LIMIT` sends *more*
traffic to a provider that is already throttling you. Backoff + 25 % jitter
de-synchronises concurrent clients, but N agents each retrying still multiplies
pressure. Keep `maxAdapterRetries` small (**1–2**) and never widen the retryable
set to include non-transient categories.

**Retry counts multiply across layers.** The worst-case number of provider calls
for a **single user request** is roughly:

```
(maxOuterRetries + 1) × maxIterations × (maxAdapterRetries + 1) × (fallback attempts ≤ adapters.length)
```

Example: `(2+1) × 10 × (2+1) × 2` = **180** provider calls from one request. A
config that looks modest per-layer explodes when stacked. **Always** set
`maxTotalTokens` and/or `maxDurationMs` so the multiplication can't run away.

**The fallback breaker never recovers to primary on its own.** Failover advances
`currentIndex` monotonically; a success only resets the *counter*, not the
*index*. Without a periodic reset, active health-check, or rebuild (see
[`fallback.md`](./fallback.md)), you stay on the degraded adapter forever — even
after the primary heals. Do **not** assume it behaves like the auto-recovering
circuit breaker; they are different breakers.

**`maxFailures` vs. adapter-list length.** Because one `chat()` call makes at
most `adapters.length` attempts, the default `maxFailures: 3` with a **2-adapter**
list **cannot trip failover inside a single call** — the primary's error
surfaces first, and the breaker only advances once the counter accumulates
across multiple calls. For deterministic failover on the first outage within a
single call, lower `maxFailures` toward `1` (at the cost of flipping on a single
transient blip). Match `maxFailures` to how many adapters you actually have.

**Resilient loop without a summarizer re-poisons the same context.** With no
`onRetry`, each outer attempt replays the original messages and re-enters the
same `max_iterations` / `token_budget` dead-end. The fresh-context benefit only
exists if `onRetry` *compresses* progress.

---

## Start here — the production default recipe

A safe baseline that survives transient blips and provider outages without
runaway cost:

```ts
import { AgentLoop } from 'harness-one/core';
import { createFallbackAdapter } from 'harness-one/advanced';

// 1. Fallback across *different* providers (never the same one twice).
//    `maxFailures` ≤ adapter count so a single outage fails over in one call.
let adapter = createFallbackAdapter({
  adapters: [primary, cheaperOrDifferentProvider],
  maxFailures: 2,
});

// 2. Periodic reset so the breaker can return to the primary after an incident.
//    (The fallback is one-way; rebuilding it is how you recover to primary.)
setInterval(() => {
  adapter = createFallbackAdapter({
    adapters: [primary, cheaperOrDifferentProvider],
    maxFailures: 2,
  });
}, 5 * 60_000);

// 3. Construct the loop *per request* so it captures the current `adapter`
//    reference — `AgentLoop` reads its adapter once at construction, so a
//    long-lived loop would pin the pre-reset fallback. Modest in-loop retry
//    for same-provider blips, plus hard budget caps.
function makeLoop() {
  return new AgentLoop({
    adapter,                              // current (possibly reset) reference
    maxAdapterRetries: 2,
    baseRetryDelayMs: 500,
    retryableErrors: ['ADAPTER_RATE_LIMIT'], // add 'ADAPTER_NETWORK' if upstream is flaky
    maxTotalTokens: 200_000,              // ← the cap that stops retry runaway
    maxDurationMs: 120_000,
  });
}
```

Add the **resilient loop** on top only for long autonomous runs that tend to
poison their own context — and only *with* a summarizing `onRetry`:

```ts
import { createResilientLoop } from 'harness-one/advanced';

const resilient = createResilientLoop({
  loopConfig: { /* the config above */ },
  maxOuterRetries: 1,
  onRetry: async ({ conversationSoFar }) => ({ summary: await summarize(conversationSoFar) }),
});
```

Protect **downstream dependencies you call yourself** (inside tool handlers)
with a `createCircuitBreaker` around those specific calls.

---

## Anti-patterns

| Anti-pattern | Why it hurts | Do instead |
|--------------|--------------|------------|
| Same provider twice in the fallback list | Both fail together in an outage | Different provider, or a cheaper/local/cached adapter in slot 2 |
| Large `maxAdapterRetries` on `ADAPTER_RATE_LIMIT` | Amplifies the throttling you're already hitting | Keep it 1–2; back off at the app layer if needed |
| Retrying non-transient errors (auth, `GUARD_VIOLATION`) | Same input fails the same way, wasting attempts + budget | Leave them out of `retryableErrors` (auth is non-retryable by design) |
| Stacking all four with no `maxTotalTokens` / `maxDurationMs` | Retry multiplication → runaway cost (see the formula) | Always cap the budget; treat the formula as your worst case |
| Resilient loop with no `onRetry` summarizer | Re-runs the same poisoned context | Provide an `onRetry` that compresses `conversationSoFar` |
| Expecting the fallback to auto-recover to primary | It's a one-way breaker; you stay degraded | Periodic reset / active health-check ([`fallback.md`](./fallback.md)) |
| `maxFailures` > adapter count, expecting single-call failover | Counter can't reach threshold in one call | Set `maxFailures` ≤ number of adapters |
| Reaching for the circuit breaker as an `AgentLoop` feature | Not exported / not wired into the loop today | Use it around downstream calls you own; use the fallback for provider failover |

---

## Related

- [`fallback.md`](./fallback.md) — fallback-adapter failure modes, logging, and recovery
- [`troubleshooting.md`](./troubleshooting.md) — error-code table and foot-guns
- [`docs/architecture/01-core.md`](../architecture/01-core.md) — AgentLoop + resilience wiring
- [`docs/architecture/14-advanced.md`](../architecture/14-advanced.md) — the `/advanced` surface
- Source: [`fallback-adapter.ts`](../../packages/core/src/core/fallback-adapter.ts) ·
  [`resilience.ts`](../../packages/core/src/core/resilience.ts) ·
  [`circuit-breaker.ts`](../../packages/core/src/infra/circuit-breaker.ts) ·
  [`agent-loop-types.ts`](../../packages/core/src/core/agent-loop-types.ts)
</content>
</invoke>
