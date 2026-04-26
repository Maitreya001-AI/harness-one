# HYPOTHESIS · 01-streaming-cli

> Frozen before any Build code was written, edited only by appending
> "predicted vs observed" annotations as Observe runs land. Per the
> 7-stage method this file is the input to Stage 5 (Harvest).

---

## ✅ Expected to be smooth

1. **AgentLoop streaming wiring** — `streaming: true` + an adapter with
   a `stream()` method should yield `text_delta` events end-to-end.
   Confidence: high. Single-adapter unit tests cover this.

2. **AbortSignal plumbing** — passing `signal:` to `AgentLoopConfig`
   should propagate to the adapter's request and to the run loop's
   own checks. Confidence: high. Documented and unit tested.

3. **CostTracker arithmetic** — given a `pricing` table and
   `recordUsage()` calls, totals should match input × rate. Confidence:
   high.

4. **HarnessLifecycle state transitions** — `markReady → beginDrain →
   completeShutdown → dispose`. Confidence: high. Linear sequence, no
   race surface.

## ⚠️ Suspected to wobble

5. **Streaming `done` event carrying `totalUsage`** — does the runtime
   guarantee a non-zero TokenUsage on the terminal `done` when the
   underlying stream emits no usage chunks?

   *Prediction: this hits zero unless the adapter explicitly emits usage.*

   *Observed (2026-04-26)*: ✅ confirmed. `createStreamingMockAdapter`
   emits exactly the chunks the caller passed — bare `{type: 'done'}`
   produces zero usage. AgentLoop sums what it receives. Recorded as
   FRICTION entry "createStreamingMockAdapter doesn't auto-attach usage
   to done". Workaround: scripted-replies now emits `done` with
   `usage`.

6. **Ctrl+C cancellation latency** — first Ctrl+C should abort the
   current turn within ~100ms. AgentLoop's signal observation is
   between iterations; in single-iteration streaming mode the gap
   between adapter return and event yield is the bound.

   *Prediction: under 100ms in mock mode; on real adapters the bound is
   the network RTT to fetch's abort.*

7. **Lifecycle `beginDrain` from `init` (not `ready`)** — what happens
   if SIGINT lands before the boot sequence runs `markReady()`?
   Possibly throws "Invalid lifecycle transition" since beginDrain
   expects `ready`.

   *Prediction: throws if signal handler races boot. Mitigation: bind
   handlers AFTER `markReady()`, which we do.*

## ❓ Genuinely unknown

8. **TraceManager.flush() under empty exporter set** — the showcase
   ships no exporter. Does `flush()` resolve, throw, or warn? The
   docstring says it's bounded but doesn't say "no-op when empty".

   *Prediction: resolves silently (functional default).*

   *Observed (2026-04-26)*: ✅ resolves silently. No warning, no error.

9. **Multi-turn history accumulation cost** — pushing
   `{role: 'user'}` + `{role: 'assistant'}` per turn into history is
   the obvious approach. Will input tokens grow per-turn quadratically
   (history × turns) by the end of a long session?

   *Prediction: yes by definition. Mock usage formula doesn't surface
   this since usage is per-message-content-derived, not history-derived.
   Real adapter would.*

10. **HarnessLifecycle `dispose()` without prior `completeShutdown()`** —
    docstring says "release all references and transition to shutdown".
    Does it accept being called from `draining`? Unknown without trying.
    Showcase always calls completeShutdown first to be safe.
