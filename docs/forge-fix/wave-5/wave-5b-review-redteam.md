# Wave-5B Red-Team Attack Report

**Target**: Wave-5B AgentLoop decomposition (commits B1–B4 on `wave-5/production-grade`)
**Scope**: `packages/core/src/core/{adapter-caller,stream-handler,iteration-runner,agent-loop,guardrail-helpers}.ts`
**Method**: Active attack construction — enumerate inputs + state that force each surface into misbehaviour; trace each to line:col; produce vitest sketches where a concrete failing test is available.
**Reviewer**: red-team-attacker
**Date**: 2026-04-15

---

## Verdict: **FIX-FIRST**

No CRITICAL / HIGH confirmed-exploit findings. One MEDIUM finding is a regression against pre-Wave-5B behaviour (adapter-stream iterator leak on external `.return()`). Two additional MEDIUMs touch observability and status correctness. Everything else is LOW / theoretical or cleared.

A single small patch to `adapter-caller.ts` (add a `finally` that calls `streamGen.return()`) closes the top finding. Nothing here is a security bug; nothing here blocks shipping Wave-5B to an internal/staging consumer. But the regression vs. pre-Wave-5B for adapter resource cleanup is worth fixing before 1.0 locks.

---

## 1. Confirmed Exploits (CRITICAL / HIGH)

**None.** Every attack vector against the new module composition was either defended by design (discriminated unions, re-entrancy guard, input-guardrail error path fail-closed) or inherits pre-Wave-5B's behaviour unchanged.

## 2. Likely Bugs (MEDIUM)

### M-1. External `.return()` on the run() generator leaks the adapter stream (regression)

- **Attack**: Start streaming, break the `for-await` on the consumer side while the adapter is mid-chunk. Pre-Wave-5B closed the adapter stream via JS iterator protocol; Wave-5B does not.
- **Trace**:
  - `packages/core/src/core/agent-loop.ts:537` — `yield* this.iterationRunner.runIteration(ctx)` (clean `yield*`)
  - `packages/core/src/core/iteration-runner.ts:352` — `yield* config.adapterCaller.call(...)` (clean `yield*`)
  - `packages/core/src/core/adapter-caller.ts:263–318` — **manual pump**: `await streamGen.next()` in a `while(true)`, NO `try/finally`, NO `yield*`.
  - `packages/core/src/core/stream-handler.ts:118` — `for await (const chunk of stream)` is suspended on the adapter's chunk.
  - When the consumer `.return()`s on run(), the JS iterator-close protocol propagates through the two `yield*` chains but stops at AdapterCaller's manual pump. `streamGen`'s `for-await` is never auto-closed. The underlying `adapter.stream(...)` generator is leaked until the abort signal fires in `finalizeRun` (`agent-loop.ts:811`).
- **Impact**: 
  - Availability / resource: adapters that do not honour `config.signal` promptly (slow network, remote adapters with in-flight HTTP/2 frames, test doubles) can keep file handles / sockets / timers alive between the moment the consumer breaks and the moment abort lands. Pre-Wave-5B this was strictly cleaner: iterator-protocol close ran concurrently with the abort, so the adapter generator saw `.return()` even without cooperating with the signal.
  - Observability: no `adapter_retry` span event or end-of-stream assertions in tests will observe the leak, so CI won't catch it.
- **Severity**: **MEDIUM** (regression vs pre-Wave-5B; no new security surface, but a real resource-cleanup regression the brief explicitly flagged).
- **Repro sketch**:
  ```ts
  it('closes adapter stream when consumer breaks mid-chunk', async () => {
    let streamReturnCalled = false;
    const adapter: AgentAdapter = {
      name: 'test',
      async *stream() {
        try {
          yield { type: 'text_delta', text: 'a' };
          // never-resolving to simulate slow adapter
          await new Promise(() => {});
          yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } };
        } finally {
          streamReturnCalled = true;
        }
      },
      async chat() { throw new Error('unused'); },
    };
    const loop = createAgentLoop({ adapter, streaming: true });
    const it = loop.run([{ role: 'user', content: 'hi' }]);
    const first = await it.next();             // 'iteration_start'
    await it.next();                           // 'text_delta'
    await it.return(undefined);                // consumer bails
    // Pre-Wave-5B: streamReturnCalled === true via iterator-close protocol.
    // Post-Wave-5B: streamReturnCalled === false; only abort signal (which
    // the test adapter ignores) would eventually close it.
    expect(streamReturnCalled).toBe(true);
  });
  ```
- **Fix**: wrap the manual pump in a `try/finally` so AdapterCaller forwards iterator close into StreamHandler:
  ```ts
  const streamGen = config.streamHandler.handle(conversation, cumulativeStreamBytesSoFar);
  try {
    while (true) { /* existing pump */ }
  } finally {
    // Forward close if we exited without draining (consumer .return()ed).
    await streamGen.return(undefined).catch(() => { /* already done */ });
  }
  ```

### M-2. `onIterationEnd` hook is not fired on external generator close / mid-iteration throw

- **Attack**: Register a hook with `onIterationEnd`; start a run; after `iteration_start` but before `message`/`done`, call `.return()` on the generator or throw from a passthrough observer.
- **Trace**:
  - `iteration-runner.ts:255–260` — `fireIterationEnd` only runs from inside `bailOut()` or the happy-path tail (L641).
  - `iteration-runner.ts:314` — `runIteration` body has **no `try/finally`**. External close unwinds silently.
  - `agent-loop.ts:779–813` — `finalizeRun` cleans up listener / span / trace but **does not call any hook**.
- **Impact**: `onIterationStart` fires, matching `onIterationEnd` does not. Metrics hooks that assume paired start/end will leak counters across disposals. This is an observability lie but **not new** — pre-Wave-5B also only fired `onIterationEnd` via the `fireIterationEnd` closure inside the run() body, so external-close missed it there too. Behaviour parity, but worth noting for the same reason the brief asks about it.
- **Severity**: **MEDIUM** (observability integrity; Wave-5B preserves this wart rather than fixing it).
- **Fix**: wrap `runIteration` in `try { ... } finally { fireIterationEnd(ctx, /* done */ false); }`, or move the guarantee to `finalizeRun`.

### M-3. `dispose()` status can be overridden to `'completed'` on the next `.next()`

- **Attack**: Call `dispose()` while the run generator is mid-iteration. The abort signal now fires; the next `.next()` hits the pre-iteration abort check and `emitTerminal` flips `_status = 'completed'` (agent-loop.ts:664). Post-condition: `loop.status === 'completed'` even though the caller disposed.
- **Trace**: `agent-loop.ts:417–433` (dispose → status 'disposed'), `agent-loop.ts:664` (emitTerminal → status 'completed'), `agent-loop.ts:548` (happy-terminated → status 'completed'). No guard against writing to `_status` when already `'disposed'`.
- **Impact**: Status-telemetry lie. Consumers reading `loop.status` to decide whether to release references see `'completed'` and may not re-dispose / garbage-collect the listener reference on `externalSignal` (though `finalizeRun` already removed it, so this is cosmetic).
- **Severity**: **MEDIUM** (correctness of the `status` getter API; no security impact). **Not a Wave-5B regression** — pre-Wave-5B's `doneEvent()` did the same write.
- **Fix**: guard `_status` writes with `if (this._status !== 'disposed') this._status = X;` in both `emitTerminal` and the terminated branch.

## 3. Theoretical Concerns (LOW)

### L-1. Cumulative stream-bytes limit can be bypassed by retries

- Each stream retry creates a fresh `StreamAggregator` with the same `cumulativeStreamBytesSoFar` parameter value. Failed attempts' bytes are discarded. With `maxAdapterRetries=5` and `maxStreamBytes=10MB`, a single adapter turn can in principle read up to 60MB before the cumulative check triggers.
- `stream-handler.ts:99–104` + `adapter-caller.ts:254–257`. Same behaviour as pre-Wave-5B (handleStream was called fresh per retry; no cross-attempt aggregation).
- **Not a Wave-5B regression.** LOW.

### L-2. `maxIterations * maxStreamBytes` overflow to `Infinity`

- `agent-loop.ts:360`: `maxCumulativeStreamBytes: this.maxIterations * this.maxStreamBytes`. No upper bound validation. A user configuring absurd `maxIterations` (e.g. `Number.MAX_SAFE_INTEGER`) disables the cumulative limit silently via JS number coercion. Requires misconfiguration; not an attacker-reachable input on a typical deployment.
- **Not a Wave-5B regression.** LOW.

### L-3. Post-adapter abort bails before usage accumulation

- `iteration-runner.ts:428–434`: the post-call abort check bailOut fires before `cumulativeUsage += safeInput/safeOutput`. The `done` event's `totalUsage` omits the last successful adapter call's usage.
- ADR documents this ordering; pre-Wave-5B had the same sequencing. Cosmetic cost-metric loss on abort. LOW.

### L-4. `run()` throws after `_status = 'running'`, before completion

- If anything inside `startRun` (e.g., `traceManager.startTrace`) throws *after* the `_status = 'running'` write (`agent-loop.ts:576`), the status is stuck at `'running'` and every subsequent `run()` will fail the re-entrancy guard. No built-in reset.
- Trace manager throwing is an unexpected-but-possible adapter failure. Recovery requires constructing a new `AgentLoop`.
- **Not a Wave-5B regression.** LOW.

### L-5. `StreamAggregator`'s cumulative check uses strict `>`; a tool-arg byte at exactly the cap is allowed

- `stream-aggregator.ts:229` / `:233`: `if (this.accumulatedBytes > this.options.maxStreamBytes)`. Off-by-one is friendly (cap inclusive). Documentation-only concern.
- **Not a Wave-5B regression.** LOW.

## 4. Cleared Paths

### ✓ Discriminated-union `BailOutInput`

Attempted `as BailOutInput` / `as ErrorBail` / etc. casts across the whole repo (grep). Only hits are in test files and do not target these shapes. The private union cannot be constructed by callers. Illegal states (`EndTurnBail` with `errorEvent`, `GuardrailBail` without `abort:true`) are rejected at compile time. **Cleared.**

### ✓ `_lastStreamErrorCategory` side-channel elimination

Grep across `packages/core/src` shows zero remaining references. The discriminated `StreamResult` carries the category on the ok:false branch; no instance field; safely concurrent across multiple `StreamHandler` instances. **Cleared.**

### ✓ Guardrail invariants (Wave-5A preserved)

- Input-guardrail throw → caught inside `runInput` (`guardrails/pipeline.ts:207–232`), becomes fail-closed `{action:'block', reason:'Guardrail error: ...'}`. The throw NEVER escapes into `runIteration`, so the bailOut path + GUARDRAIL_VIOLATION non-retryable classification + abortController.abort() ALL fire. Attack cleared.
- `tool_output` guardrail block after `conversation.push` — runs against the correct assistant message; stub rewrite touches `resultContent` before the tool message is pushed (`iteration-runner.ts:615–627`). `toolCalls` iteration continues. Attack cleared.
- Output guardrail "same time as `done`" — the discriminated union prevents a single `bailOut` call from emitting both. Guardrail-block bails via `reason:'error'`, terminated outcome carries `reason:'error'`, orchestrator yields `{type:'done', reason:'error'}`. Only one terminal. Cleared.

### ✓ Double-`{type:'error'}` on retry-then-terminal

The pump buffers `pendingError` and discards it when a retry is taken (`adapter-caller.ts:288`), forwards it when terminal (`:301`). Abort-during-backoff also discards the buffered error — the synthetic `ABORTED` bail yields the single `AbortedError` via `bailOut`. Grep of all terminal paths: one error event per failed adapter turn. **Cleared.**

### ✓ onRetry stale-closure capture (B3 migration from `_currentIterationSpanId`)

`adapter-caller.ts:230` captures `onRetry` per-call. `iteration-runner.ts:355` supplies a closure that reads `ctx.iterationSpanId` at event-fire time (not at capture time). Since `ctx.iterationSpanId` is mutated in place by `runIteration` (opened per iteration, nulled by `endSpan`), the closure always sees the current iteration's span. The earlier-iteration's span cannot be observed because runIteration is serialised (one `await yield*` at a time; JS single-threaded). **Cleared.**

### ✓ Re-entrancy guard

Two concurrent `run()` calls: JS single-threading guarantees the first `.next()` runs the guard → status flip atomically before the second `.next()` begins. The second `.next()` throws HarnessError `INVALID_STATE`. **Cleared.**

### ✓ Type-system bypasses

- No `as unknown as X` in production files under `packages/core/src/core/` (two hits in test code casting fake AbortSignals; benign).
- No `@ts-ignore` / `@ts-expect-error` anywhere.
- `strategyOptions` is `Readonly<>` at the `IterationRunnerConfig` boundary and `Object.freeze`-d at the AgentLoop boundary; no cast-away. **Cleared.**

### ✓ Manual pump's `done:true` boundary

The pump at `adapter-caller.ts:263–318` checks `step.done` on every iteration before handling `step.value` as an event. `step.value` on `done:true` is the `StreamResult` (success or failure). The pump always returns / breaks when `step.done` is true; cannot call `streamGen.next()` again after the return. **Cleared.**

### ✓ `runHook` swallow semantics

`iteration-runner.ts:218–241` mirrors `agent-loop.ts:441–467`: per-hook try/catch, logger also wrapped. A hook throw cannot propagate past the loop body; event stream is not interrupted. **Cleared.**

### ✓ `maxStreamBytes` / `maxToolArgBytes` boundary parity

`stream-handler.ts:99–104` constructs a fresh aggregator with identical options to pre-Wave-5B's `handleStream:L1112-L1117`. The aggregator (`stream-aggregator.ts:228–239`) enforces per-chunk: same strict `>` comparison, same cumulative additivity. Size-limit errors fire at the same chunk boundary. **Cleared.** (L-1 is a retries-across-attempts concern, not a boundary regression.)

---

## Appendix: Attack vectors explored but producing no finding

1. **Abort during backoff between retries synthesising `errorCategory:'ABORTED'` twice** — checked: backoff's `catch` swallows, next for-loop iteration sees `attempt>0 && signal.aborted`, returns `{ok:false, errorCategory:'ABORTED'}` once. `bailOut` yields `AbortedError` once.
2. **Generator `.throw()` while inside `executionStrategy.execute`** — `await` resumes with throw; unwinds through awaits; no `finally` on the `for await` loop body but the outer `runIteration` has no `finally` either → the throw propagates into run()'s `yield*` → run()'s `finally` runs `finalizeRun`. Same as pre-Wave-5B.
3. **`adapter.stream` undefined at runtime despite `streaming:true`** — `agent-loop.ts:369` computes `effectiveStreaming` via `typeof this.adapter.stream === 'function'` and passes falsey `streaming:false` to AdapterCaller. The stream branch is dead. Cleared.
4. **ExecutionStrategy mutating `strategyOptions` after receiving it** — frozen via `Object.freeze` at `agent-loop.ts:340`. Attempts to mutate throw in strict mode, silently no-op in sloppy; either way the shared reference cannot be corrupted. Cleared.
