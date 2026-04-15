# Wave-5B ADR · AgentLoop 3-Module Decomposition (v2)

**Status**: Proposed, Round 2 (incorporates critic ACCEPT-WITH-CHANGES)
**Architect**: solution-architect
**Date**: 2026-04-15
**Depends on**: Wave-5A (merged) · **Invariants**: `decisions.md` (1.0-rc, fail-closed, no back-compat)
**Supersedes**: `wave-5b-adr.md` (v1) — retained on disk for diff review
**Resolves**: critic v1 §1-5 (HIGH/HIGH/HIGH/HIGH/MEDIUM) + lower-priority points

---

## 1. Context

`packages/core/src/core/agent-loop.ts` is 1268 LOC, with `AgentLoop.run()` at L436–L1032 — a ~600-LOC async generator braiding iteration control, adapter calls, streaming translation, retry-with-backoff, guardrail hook points (input L587–L612 / tool_output L948–L978 / output L794–L821), per-iteration tracing, hook dispatch, and six duplicated abort/span/done triplets. The `_lastStreamErrorCategory` instance side-channel (L246, set at L1149, read at L643–L644) breaks concurrency and conflates `handleStream`'s return type. Wave-5A hardened the three guardrail hook points; Wave-5B decomposes the god-method without disturbing them. **v2 changes**: public-surface hiding deferred to Wave-5C (lead decision on OQ4); `IterationRunner` is now stateless with all per-run state on `IterationContext`; `onRetry` carries the chat error preview; `BailOutInput` is a discriminated union; `IterationOutcome` carries `totalUsage` directly.

## 2. Decision — Three Modules

### Boundary rationale (unchanged)

- **2 modules** fails M-4: streaming is the only place the side-channel exists, so isolating it is non-negotiable.
- **4 modules** pays no dividend: `backoff()` is 37 LOC of timer+abort logic with one caller; lives naturally as a private helper on AdapterCaller.
- **The chosen split is the minimal cut** that (a) eliminates the side-channel, (b) makes `run()` orchestration-only, (c) localizes retry policy behind AdapterCaller.

### 2.1 `AdapterCaller` (new file: `packages/core/src/core/adapter-caller.ts`)

**Responsibility** — Execute one adapter turn (streaming or non-streaming) with retry-with-backoff and return a unified discriminated result. Delegates streaming to StreamHandler; never yields events directly to the consumer (pass-through only from StreamHandler).

**Public interface** (exact):

```ts
export interface AdapterCallOk {
  readonly ok: true;
  readonly message: Message;
  readonly usage: TokenUsage;
  /** 0 on the non-streaming path; aggregator.bytesRead on the streaming path. */
  readonly bytesRead: number;
  readonly path: 'chat' | 'stream';
  /** How many retries were burned (for observer attribution). */
  readonly attempts: number;
}
export interface AdapterCallFail {
  readonly ok: false;
  readonly error: HarnessError | Error;
  readonly errorCategory: string; // includes synthetic 'ABORTED' when backoff was aborted
  readonly path: 'chat' | 'stream';
  readonly attempts: number;
}
export type AdapterCallResult = AdapterCallOk | AdapterCallFail;

/**
 * v2 change (critic §3): onRetry carries `errorPreview` so the chat path can
 * replicate today's `adapter_retry` span attribute `error: msg.slice(0,500)`
 * verbatim (agent-loop.ts:698). Stream path may omit. This asymmetry mirrors
 * today's L648-L650 (stream) vs L693-L701 (chat).
 */
export interface AdapterRetryInfo {
  readonly attempt: number;
  readonly errorCategory: string;
  readonly path: 'chat' | 'stream';
  /** REQUIRED on the chat path; UNDEFINED on the stream path. ≤500 chars. */
  readonly errorPreview?: string;
}

export interface AdapterCallerConfig {
  readonly adapter: AgentAdapter;
  readonly tools?: readonly ToolSchema[];
  readonly streaming: boolean;
  readonly signal: AbortSignal;                 // loop's internal abortController.signal
  readonly maxAdapterRetries: number;
  readonly baseRetryDelayMs: number;
  readonly retryableErrors: readonly string[];
  readonly streamHandler: StreamHandler;        // injected; see §2.2
  readonly onRetry?: (info: AdapterRetryInfo) => void;
}

export interface AdapterCaller {
  /**
   * Execute one adapter turn. On streaming path, forwards text_delta /
   * tool_call_delta / warning / error events from StreamHandler; on chat
   * path yields NOTHING (return-only). Internal retry loop consumes abort
   * during backoff and surfaces it as ok:false, errorCategory:'ABORTED'.
   *
   * Asymmetry: StreamHandler yields {type:'error'} itself on stream failure;
   * AdapterCaller MUST NOT re-yield in that case. On chat failure,
   * AdapterCaller yields NO error — IterationRunner yields one via bailOut.
   * This preserves today's "exactly one `error` event per failed adapter call".
   */
  call(
    conversation: readonly Message[],
    cumulativeStreamBytesSoFar: number,
  ): AsyncGenerator<AgentEvent, AdapterCallResult>;
}

export function createAdapterCaller(config: Readonly<AdapterCallerConfig>): AdapterCaller;
```

**State it owns** — None as instance fields. Retry attempt counter is a local `let` per `call()`; no persistence across turns.

**What it explicitly does NOT own** — Guardrails; TraceManager / span handles (tracing surfaces via `onRetry` callback); conversation mutation; iteration counters, cumulative usage, hook dispatch; AbortController (it only holds a signal).

### 2.2 `StreamHandler` (new file: `packages/core/src/core/stream-handler.ts`)

**Responsibility** — Translate one `adapter.stream()` call into `AgentEvent` sequence, accumulate via `StreamAggregator`, return a discriminated union. Replaces `AgentLoop.handleStream` (L1106–L1160); eliminates `_lastStreamErrorCategory`.

**Public interface** (exact):

```ts
export type StreamResult =
  | { readonly ok: true; readonly message: Message; readonly usage: TokenUsage; readonly bytesRead: number }
  | { readonly ok: false; readonly error: HarnessError | Error; readonly errorCategory: string };

export interface StreamHandlerConfig {
  readonly adapter: AgentAdapter;             // `adapter.stream` must be defined — caller's responsibility
  readonly tools?: readonly ToolSchema[];
  readonly signal: AbortSignal;
  readonly maxStreamBytes: number;
  readonly maxToolArgBytes: number;
  /**
   * Cap on cumulative bytes across iterations. Today derived as
   * `maxIterations * maxStreamBytes` at run() L503. v2 DESIGN DECISION
   * (critic lower §2): keep this as a constructor-time derived constant.
   * Future per-run overrides can be added by threading it through a new
   * field on IterationContext; not needed today.
   */
  readonly maxCumulativeStreamBytes: number;
}

export interface StreamHandler {
  /**
   * Consume one adapter.stream() call.
   * YIELDS: text_delta | tool_call_delta | warning | error.
   * RETURNS: StreamResult.
   * On failure, yields the `{type:'error'}` event JUST BEFORE returning
   * {ok:false,...} — preserves today's observer-visible event stream.
   */
  handle(
    conversation: readonly Message[],
    cumulativeStreamBytesSoFar: number,
  ): AsyncGenerator<AgentEvent, StreamResult>;
}

export function createStreamHandler(config: Readonly<StreamHandlerConfig>): StreamHandler;
```

**State it owns** — None externally-visible. A fresh `StreamAggregator` is constructed per `handle()` call (matches today L1111). Stateless across calls → safely reusable.

**What it explicitly does NOT own** — Retry decisions; the side-channel (deleted); guardrails, tracing, hooks, conversation building.

### 2.3 `IterationRunner` (new file: `packages/core/src/core/iteration-runner.ts`)

**Responsibility** — Run exactly one agent iteration: pre-call budget/abort checks (only those that happen mid-iteration — pre-iteration checks stay in `run()`), input-guardrail, delegated adapter call, post-call abort/budget re-check, output-guardrail on no-tool-calls, tool execution, tool_output guardrails, conversation mutation. Owns the `bailOut` helper.

**v2 invariant (critic §2)** — **IterationRunner is stateless across runs. All per-run mutable state lives on `IterationContext`, which is freshly allocated per `run()` call.** No mutable boxes on `IterationRunnerConfig`. Reusing a single IterationRunner across two `run()` calls is safe because the runner carries no durable state; the first call's `IterationContext` goes out of scope when `run()` returns. Earlier v1 defence ("avoids allocation per iteration") was counterfactual — today's baseline is closure-scoped `let` locals, not boxes — and is **struck**.

**Public interface** (exact, v2):

```ts
export type IterationOutcome =
  | { readonly kind: 'continue' }
  /**
   * v2 change (critic §6 / edit #6): carries totalUsage so run() can
   * synthesise the done AgentEvent without a callback. run() owns the
   * `_status` transition on the event pass-through.
   */
  | { readonly kind: 'terminated'; readonly reason: DoneReason; readonly totalUsage: TokenUsage };

/**
 * v2 change (critic §2 / edit #2): freshly allocated per run(). Carries ALL
 * per-run mutable state — nothing leaks onto IterationRunner or
 * IterationRunnerConfig.
 */
export interface IterationContext {
  /** Caller-owned mutable conversation buffer. IterationRunner pushes assistant + tool messages. */
  readonly conversation: Message[];
  /** 1-based iteration counter, pre-incremented by the orchestrator. */
  readonly iteration: number;
  /** Cumulative stream bytes across prior iterations; runIteration updates in place. */
  cumulativeStreamBytes: { value: number };
  /** Active iteration span id; runIteration manages endSpan; run()'s finally reads this too (see R5). */
  iterationSpanId: string | undefined;
  /** Trace id for starting child tool spans. */
  readonly traceId: string | undefined;
  /** v2 change: accumulated token usage across iterations. Moved from config → context. */
  cumulativeUsage: { inputTokens: number; outputTokens: number };
  /** v2 change: tool-call counter. Moved from config → context. */
  toolCallCounter: { value: number };
  /** v2 change: once-fired flag for onIterationEnd. Moved from run()'s closure → context. */
  iterationEndFired: { value: boolean };
}

export interface IterationRunnerConfig {
  readonly adapterCaller: AdapterCaller;
  readonly executionStrategy: ExecutionStrategy;
  readonly strategyOptions: Readonly<{
    readonly signal: AbortSignal;
    readonly getToolMeta?: (name: string) => { sequential?: boolean } | undefined;
  }>;
  readonly abortController: AbortController;      // IterationRunner aborts via this in bailOut
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly toolTimeoutMs?: number;
  readonly maxTotalTokens: number;
  readonly inputPipeline?: GuardrailPipeline;
  readonly outputPipeline?: GuardrailPipeline;
  readonly traceManager?: AgentLoopTraceManager;
  readonly hooks: readonly AgentLoopHook[];
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  // v2: NO cumulativeUsage / toolCallCounter / buildDoneEvent — all on context / produced by outcome.
}

export interface IterationRunner {
  runIteration(ctx: IterationContext): AsyncGenerator<AgentEvent, IterationOutcome>;
}

export function createIterationRunner(config: Readonly<IterationRunnerConfig>): IterationRunner;
```

**State it owns** — NONE per-run. All mutable state on `IterationContext`.

**What it explicitly does NOT own** — The `while(true)` orchestration loop (stays in `run()`); `_status` transitions, external signal listener, one-time no-pipeline warning, re-entrancy guard; run-level trace (startTrace / endTrace); adapter dispatch; `_iteration` / `_totalToolCalls` fields on `AgentLoop` (the orchestrator FORWARDS context values to those fields after each `runIteration()` — see §7 Step 3).

## 3. Sequence (one iteration)

```
AgentLoop.run() orchestrator
 │  ── pre-checks (isAborted? iteration > max? cumulative token budget?)
 │       each → emitTerminal(reason, errorEvent?) inline helper
 │       (pre-iteration, before iterationSpanId exists)
 │  ── prune conversation
 │  ── ctx.iterationSpanId = tm.startSpan(iteration-N); setSpanAttributes
 │  ── yield iteration_start ; runHook onIterationStart
 │  ── this._iteration = ctx.iteration        // forward to AgentLoop field for getMetrics
 │
 ▼
IterationRunner.runIteration(ctx)
 │
 │  [1] inputPipeline? → runInput(latestUser) → blocked ⇒ bailOut(GuardrailBail{phase:'input', ...})
 │  [2] yield* adapterCaller.call(conversation, ctx.cumulativeStreamBytes.value)
 │       ├─ AdapterCaller: internal retry loop
 │       ├─    streaming → yield* streamHandler.handle(...) (errors yielded by StreamHandler)
 │       └─    chat       → await adapter.chat(...) (error NOT yielded here)
 │       if !result.ok:
 │           if errorCategory === 'ABORTED'    ⇒ bailOut(ErrorBail{reason:'aborted', errorEvent:AbortedError})
 │           else if path === 'chat'           ⇒ bailOut(ErrorBail{reason:'error', errorEvent:wrap(result.error)})
 │           else (path === 'stream')          ⇒ bailOut(ErrorBail{reason:'error', errorEvent: /* already yielded by handler; skip */})
 │       ctx.cumulativeStreamBytes.value += result.bytesRead
 │       setSpanAttributes({inputTokens, outputTokens, toolCount, path: result.path})
 │       runHook('onCost', {iteration, usage: result.usage}); clampAndAccumulate(ctx.cumulativeUsage)
 │
 │  [3] post-call abort check → bailOut(ErrorBail{reason:'aborted'})
 │  [4] post-call token budget → bailOut(BudgetBail{message, error:TokenBudgetExceededError})
 │
 │  [5] toolCalls = assistantMsg.role === 'assistant' ? assistantMsg.toolCalls : undefined
 │       if none:
 │          outputPipeline? → runOutput(finalContent) → blocked ⇒ bailOut(GuardrailBail{phase:'output'})
 │          ⇒ bailOut(EndTurnBail{message:{message, usage:result.usage}})
 │
 │  [6] conversation.push(assistantMsg)
 │       for tc of toolCalls: yield tool_call ; runHook onToolCall
 │       executionResults = await executionStrategy.execute(toolCalls, handler, strategyOptions)
 │       for r of executionResults:
 │          yield tool_result ; ctx.toolCallCounter.value++
 │          resultContent = serialize(r)
 │          outputPipeline? → runToolOutput → blocked ⇒ yield guardrail_blocked(phase:'tool_output'); rewrite stub
 │          conversation.push(toolResultMsg)
 │
 │  [7] post-tools abort → bailOut(ErrorBail{reason:'aborted'})
 │  [8] fireIterationEnd(false); endSpan('completed'); ctx.iterationSpanId = undefined
 │      return { kind:'continue' }
 │
 ▼
run() orchestrator
 │  this._totalToolCalls = ctx.toolCallCounter.value      // forward to AgentLoop field for getMetrics
 │  this.cumulativeUsage = {...ctx.cumulativeUsage}       // forward to AgentLoop field for .usage getter
 │  switch outcome.kind:
 │     'continue'   → next iteration
 │     'terminated' → this._status = 'completed';
 │                    // IterationRunner has already yielded the done event via bailOut;
 │                    // run() just observes the outcome and exits the while loop
```

## 4. `bailOut(reason)` Contract — Discriminated Union (v2)

**v2 change (critic §5 / edit #5)**: optional-bag `BailOutInput` is recast as a discriminated union. Illegal states (e.g. `{reason:'end_turn', errorEvent:foo}`) no longer typecheck; the type system now prevents the M-4-era bug pattern "guardrail bail forgot to call abortController.abort()".

```ts
// Private to IterationRunner — NOT exported.

type ErrorBail = {
  readonly reason: 'error' | 'aborted' | 'max_iterations';
  readonly errorEvent?: Extract<AgentEvent, { type: 'error' }>;
  /**
   * Skip yielding errorEvent when the event is already on the wire
   * (streaming failure path — StreamHandler yielded it). Default: false.
   */
  readonly errorAlreadyYielded?: boolean;
};

type GuardrailBail = {
  readonly reason: 'error';
  /** Required — guardrail blocks ALWAYS abort upstream work. */
  readonly abort: true;
  readonly guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }>;
  readonly errorEvent: Extract<AgentEvent, { type: 'error' }>;
};

type BudgetBail = {
  readonly reason: 'token_budget';
  /** Required — today's L780 yields the message before the error. */
  readonly messageEvent: Extract<AgentEvent, { type: 'message' }>;
  readonly errorEvent: Extract<AgentEvent, { type: 'error' }>;
};

type EndTurnBail = {
  readonly reason: 'end_turn';
  /** Required — end_turn MUST yield the final assistant message. */
  readonly messageEvent: Extract<AgentEvent, { type: 'message' }>;
};

type BailOutInput = ErrorBail | GuardrailBail | BudgetBail | EndTurnBail;

private async *bailOut(
  ctx: IterationContext,
  input: BailOutInput,
): AsyncGenerator<AgentEvent, IterationOutcome> {
  switch (input.reason) {
    case 'end_turn': {
      yield input.messageEvent;
      this.endSpan(ctx, 'completed');
      this.fireIterationEnd(ctx, true);
      return { kind: 'terminated', reason: 'end_turn',
               totalUsage: snapshotUsage(ctx.cumulativeUsage) };
    }
    case 'token_budget': {
      yield input.messageEvent;
      yield input.errorEvent;
      this.endSpan(ctx, 'error');
      this.fireIterationEnd(ctx, true);
      return { kind: 'terminated', reason: 'token_budget',
               totalUsage: snapshotUsage(ctx.cumulativeUsage) };
    }
    default: {
      // 'error' | 'aborted' | 'max_iterations' — ErrorBail OR GuardrailBail
      if ('abort' in input && input.abort) this.config.abortController.abort();
      if ('guardrailEvent' in input) yield input.guardrailEvent;
      const alreadyYielded = 'errorAlreadyYielded' in input && input.errorAlreadyYielded === true;
      if (!alreadyYielded && input.errorEvent) yield input.errorEvent;
      this.endSpan(ctx, 'error');
      this.fireIterationEnd(ctx, true);
      return { kind: 'terminated', reason: input.reason,
               totalUsage: snapshotUsage(ctx.cumulativeUsage) };
    }
  }
}

// endSpan / fireIterationEnd are tiny private helpers that NULL ctx.iterationSpanId
// after endSpan (see R5) and flip ctx.iterationEndFired.value.
```

**Call-site mapping** (v2, unchanged shape; updated to use tagged variants):

| Today (line range) | v2 variant |
|---|---|
| L507-L513 (pre-check abort) | stays in run(); uses run()-local `emitTerminal('aborted', AbortedError)` helper (~12 LOC) |
| L519-L526 (max_iterations) | stays in run(); `emitTerminal('max_iterations', MaxIterationsError)` |
| L530-L537 (pre-call token budget) | stays in run(); `emitTerminal('token_budget', TokenBudgetExceededError)` |
| L587-L612 (input guardrail block) | `bailOut(GuardrailBail{abort:true, guardrailEvent{phase:'input'}, errorEvent})` |
| L624-L629 (mid-retry abort) | moved INTO AdapterCaller → returns {ok:false, errorCategory:'ABORTED'} → `bailOut(ErrorBail{reason:'aborted', errorEvent:AbortedError})` |
| L661-L673 (stream retries exhausted) | AdapterCaller returns {ok:false, path:'stream'} → `bailOut(ErrorBail{reason:'error', errorAlreadyYielded:true})` (StreamHandler already yielded the error) |
| L711-L730 (chat retries exhausted) | AdapterCaller returns {ok:false, path:'chat'} → `bailOut(ErrorBail{reason:'error', errorEvent:wrap(result.error)})` |
| L735-L741 (unreachable) | short-circuit `bailOut(ErrorBail{reason:'error'})` |
| L757-L763 (post-adapter abort) | `bailOut(ErrorBail{reason:'aborted', errorEvent:AbortedError})` |
| L778-L787 (post-call token budget) | `bailOut(BudgetBail{messageEvent, errorEvent:TokenBudgetExceededError})` |
| L794-L820 (output guardrail on final) | `bailOut(GuardrailBail{abort:true, guardrailEvent{phase:'output'}, errorEvent})` |
| L822-L827 (end_turn happy path) | `bailOut(EndTurnBail{messageEvent})` |
| L988-L995 (post-tools abort) | `bailOut(ErrorBail{reason:'aborted', errorEvent:AbortedError})` |

Type system now rejects, at compile time: (a) GuardrailBail without `abort:true`; (b) EndTurnBail with an errorEvent; (c) BudgetBail without a messageEvent.

## 5. Discriminated Union for Stream Result — No Side-Channel

Type defined in §2.2. Consumption pattern in AdapterCaller:

```ts
// streaming branch — replaces today's L634-L673
const streamResult = yield* this.config.streamHandler.handle(conversation, cumulativeStreamBytesSoFar);
if (streamResult.ok) {
  return { ok: true, message: streamResult.message, usage: streamResult.usage,
           bytesRead: streamResult.bytesRead, path: 'stream', attempts: attempt };
}
if (this.config.retryableErrors.includes(streamResult.errorCategory) && attempt < this.config.maxAdapterRetries) {
  this.config.onRetry?.({ attempt, errorCategory: streamResult.errorCategory, path: 'stream' });
  // errorPreview OMITTED on stream path (v2 §2.1 asymmetry doc)
  try { await this.backoff(attempt); } catch { /* aborted during backoff — handled by abort re-check top of next iter */ }
  continue;
}
return { ok: false, error: streamResult.error, errorCategory: streamResult.errorCategory,
         path: 'stream', attempts: attempt };
```

Chat branch populates `errorPreview` per v2 §2.1:

```ts
const errorCategory = categorizeAdapterError(err);
if (this.config.retryableErrors.includes(errorCategory) && attempt < this.config.maxAdapterRetries) {
  this.config.onRetry?.({
    attempt, errorCategory, path: 'chat',
    errorPreview: (err instanceof Error ? err.message : String(err)).slice(0, 500),
  });
  ...
}
```

**Invariants**: (1) no instance field; (2) category travels with error; (3) exactly one `error` AgentEvent per failed adapter call — see §9 R1 mitigation.

Delete `AgentLoop._lastStreamErrorCategory` (L246) and its read/reset at L643-L644.

## 6. Wave-5A Guardrail Integration — Where Each Hook Lives

| Hook | Today (agent-loop.ts) | v2 location |
|---|---|---|
| **input** — `runInput` before adapter call | L587-L612 inline | `IterationRunner.runIteration` step [1], BEFORE `adapterCaller.call`. |
| **tool_output** — `runToolOutput` after each tool result | L954-L977 inline | `IterationRunner.runIteration` step [6], inside `for (execResult)` loop; rewrites `resultContent` to GUARDRAIL_VIOLATION stub; loop continues. |
| **output** — `runOutput` on final assistant answer | L799-L820 inline | `IterationRunner.runIteration` step [5], BEFORE yielding final `{type:'message'}` when no tool calls. |

All three firing semantics preserved verbatim via `bailOut(GuardrailBail{...})` for input/output; tool_output stays as inline rewrite (no bailOut, no abort).

**Classifier preservation**: `categorizeAdapterError` in `error-classifier.ts` already returns `'GUARDRAIL_VIOLATION'` for `HarnessError(code='GUARDRAIL_VIOLATION')` (L33-L35). Default `retryableErrors = ['ADAPTER_RATE_LIMIT']`. AdapterCaller uses `.includes(errorCategory)` — GUARDRAIL_VIOLATION never matches → non-retryable. Invariant survives trivially.

**Helpers** `findLatestUserMessage` + `pickBlockingGuardName` move from `AgentLoop` statics to a new `packages/core/src/core/guardrail-helpers.ts`.

Wave-5A test suite (`agent-loop-guardrails.test.ts`, 326 LOC, 10 tests) unchanged — asserts at consumer boundary; identical events.

## 7. Migration Plan — 4 Incremental TDD Steps (v2)

Each step leaves the full test suite green before the next starts. All 3780+ tests must pass after each step.

### Step 1 — Extract `AdapterCaller.callOnce` (chat single-attempt only); retry loop stays in run()

**v2 change (critic §4 / edit #4)**: explicitly **Option A** from the critique. The outer `for (let attempt = 0; attempt <= maxAdapterRetries; attempt++)` loop at **agent-loop.ts L622** is KEPT in `run()` for Step 1. Only the single `await adapter.chat(...)` call + its catch-and-categorize moves into a thin `AdapterCaller.callOnce`. Retry ownership moves to AdapterCaller in Step 2 when streaming joins.

**Edits**:
- New file `adapter-caller.ts` with only `callOnce(conversation)` — wraps `adapter.chat`, returns `{ok:true, message, usage} | {ok:false, error, errorCategory}`. No retry loop yet. No streaming branch yet.
- In `run()`: L677-L686 (chat try block) → `const r = await this.adapterCaller.callOnce(conversation); if (r.ok) {assistantMsg=r.message; responseUsage=r.usage; adapterCallSucceeded=true; break;}`. L687-L731 (catch branch) → uses `r.errorCategory`, rest unchanged (retry-or-bail stays inline).
- Streaming branch (L632-L674) completely untouched in Step 1 — still uses `this.handleStream` + `this._lastStreamErrorCategory`.
- Constructor instantiates `createAdapterCaller({adapter, tools, streaming: this.streaming, signal: this.abortController.signal, ...retryConfig})` but only `callOnce` is used in Step 1.

**Hybrid instance structure after Step 1** (for reviewers):
- `this.adapterCaller.callOnce(...)` handles chat attempt.
- `this.handleStream(...)` handles stream attempt (unchanged).
- `this._lastStreamErrorCategory` still exists (deleted in Step 2).
- The `for (let attempt...)` loop at L622 encloses BOTH branches (same retry accounting on both sides — no split).

**Concrete test walkthroughs**:

| Test | Path through Step 1 | Path through Step 2 | Path through Step 3 |
|---|---|---|---|
| `agent-loop.test.ts > "retries on rate-limit then succeeds"` (chat; near L258) | run() for-loop → `adapterCaller.callOnce` (attempt 0 fails, errorCategory='ADAPTER_RATE_LIMIT') → retry-or-bail inline → `backoff()` inline → attempt 1 via `callOnce` succeeds | run() for-loop deleted; `adapterCaller.call` owns retry; same observable events | same as Step 2 + IterationRunner wraps |
| `streaming-errors.test.ts > "retries on stream rate-limit then succeeds"` | UNCHANGED — still via inline `handleStream` + `_lastStreamErrorCategory` | Now via `streamHandler.handle` → returns `{ok:false, errorCategory}` → `adapterCaller.call` retry loop → second attempt succeeds | same as Step 2 + IterationRunner wraps |
| `span-enrichment.test.ts > "adapter_retry span event fires"` | unchanged; event emitted inline at L647 (stream) or L693 (chat) | `onRetry` callback emits the span event via AgentLoop closure; v2 passes `errorPreview` on chat path so `error` attribute survives | unchanged from Step 2 |

**Tests that must stay green** (Step 1):
- `agent-loop.test.ts` all ~30 non-streaming tests (L37-L540 range) — especially retry tests (L258, L404).
- `resilience.test.ts` all 602 LOC — `vi.spyOn(AgentLoop.prototype, 'dispose')` at L522/557/582 unaffected (we're NOT touching public surface in Step 1).
- `streaming-errors.test.ts` — 100% unchanged code paths; sanity pass.
- `error-classifier.test.ts` — untouched.

### Step 2 — Extract `StreamHandler`; AdapterCaller owns retry; delete `_lastStreamErrorCategory`

**Edits**:
- New file `stream-handler.ts` — body of today's `handleStream` L1106-L1160 but returns `StreamResult` instead of null.
- Extend AdapterCaller: `call()` (full interface per §2.1) now owns the `for (let attempt...)` retry loop internally; branches on `this.config.streaming` to call `streamHandler.handle` or `adapter.chat`.
- Delete: `AgentLoop.handleStream` method (L1106-L1160), `AgentLoop._lastStreamErrorCategory` field (L246), the outer `for (let attempt...)` loop in `run()` (L622) — the retry logic now lives in AdapterCaller. Delete the `handleStream`-related retry-or-bail block at L634-L674.
- `run()` now: `const result = yield* this.adapterCaller.call(conversation, cumulativeStreamBytes); if (!result.ok) { /* inline bail — still no IterationRunner yet */ } ...`
- Constructor: `createStreamHandler({adapter, tools, signal: this.abortController.signal, maxStreamBytes, maxToolArgBytes, maxCumulativeStreamBytes: maxIterations * maxStreamBytes})` → pass to `createAdapterCaller`.
- `onRetry` callback wired to `tm.addSpanEvent(iterationSpanId, {name:'adapter_retry', attributes: {attempt, errorCategory, path, ...(errorPreview !== undefined ? {error: errorPreview} : {})}})`.

**Step 2 gating tests (critic §3 / edit #3 + critic lower R1)**:
- **NEW REQUIRED TEST**: `span-enrichment.test.ts` — assert `adapter_retry` span event on **chat path** carries `error` attribute ≤500 chars. Covers the contract at `docs/architecture/01-core.md:161`.
- **NEW REQUIRED TEST**: "exactly one `{type:'error'}` event per failed stream across all retries" — guards against the double-emit regression risk from the two-yield-points split.
- `streaming-errors.test.ts` — all 448 LOC, critical suite.
- `agent-loop.test.ts` streaming tests (L569+, ~15 tests).
- `stream-aggregator.test.ts` — API unchanged.
- `resilience.test.ts` — retry timing / backoff tests.

### Step 3 — Extract `IterationRunner` + `bailOut`

**Edits**:
- New file `iteration-runner.ts` — body is today's `run()` L506-L1001 minus outer `while(true)` minus pre-iteration checks (abort/max/pre-call-budget) minus finally cleanup.
- Move L587-L612 (input), L794-L820 (output), L948-L978 (tool_output) inline inside `runIteration` — semantic no-op.
- Move helpers: `AgentLoop.findLatestUserMessage` + `AgentLoop.pickBlockingGuardName` → new `guardrail-helpers.ts`.
- Delete `AgentLoop.categorizeAdapterError` static (L1162-L1165) — M-7 cleanup (OQ1 lead decision: confirmed delete).
- Introduce `bailOut` per §4 discriminated union; replace the 9 in-iteration terminal sites per §4 table.
- `run()` now constructs `IterationContext` freshly each call (v2 §2.3 invariant):
  ```ts
  const ctx: IterationContext = {
    conversation: [...messages],
    iteration: 0, // will be pre-incremented per iteration
    cumulativeStreamBytes: { value: 0 },
    iterationSpanId: undefined,
    traceId,
    cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
    toolCallCounter: { value: 0 },
    iterationEndFired: { value: false }, // reset per iteration inside runIteration
  };
  ```
  (Note: `iteration` is updated per-iter by casting via a fresh ctx-per-iter or mutable; ADR keeps ctx per-run and uses a mutable `iteration` — trivial, doc comment explains.)
- **v2 structural edit (critic §6 / edit #6)**: `IterationOutcome.terminated` now carries `totalUsage`. Drop `buildDoneEvent` callback entirely. `run()` synthesises the done event from the outcome:
  ```ts
  if (outcome.kind === 'terminated') {
    this._status = 'completed';
    yield { type: 'done', reason: outcome.reason, totalUsage: outcome.totalUsage };
    return;
  }
  ```
  (Note: the done event is yielded by `run()`, NOT by IterationRunner. IterationRunner's bailOut returns the outcome; run() yields the event. This is a clean separation and matches the critic's "remove callback" edit.)
- **v2 explicit field migration (critic lower / edit #8)**:
  - `this._totalToolCalls` (L264) — REMAINS on `AgentLoop` for `getMetrics()` (L413). Write path: `run()` reads `ctx.toolCallCounter.value` after each `runIteration()` and forwards to `this._totalToolCalls`.
  - `this._iteration` (L263) — REMAINS on `AgentLoop` for `getMetrics()`. Write path: `run()` writes `this._iteration = iteration` inside the while loop BEFORE calling `runIteration` (same spot as today L518).
  - `this.cumulativeUsage` (L259) — REMAINS on `AgentLoop` for the `usage` getter (L348). Write path: `run()` syncs `this.cumulativeUsage = {...ctx.cumulativeUsage}` after each `runIteration()`.
- `ExecutionStrategy.execute` in `types.ts` — tighten `options` to `Readonly<>` (M-5). `execution-strategies.ts` sequential + parallel implementations only read `options.signal`/`options.getToolMeta` — no mutation → typecheck-clean (gate check before merge).
- **v2 R5 mitigation (critic lower)**: `run()`'s outer `finally` reads `ctx.iterationSpanId` instead of a local `let` — ctx is a run-level durable that outlives `runIteration`:
  ```ts
  } finally {
    if (ctx.iterationSpanId && tm) { try { tm.endSpan(ctx.iterationSpanId, 'error'); } catch {} }
    if (traceId && tm) { try { tm.endTrace(traceId, finalEventEmitted ? 'completed' : 'error'); } catch {} }
    ...
  }
  ```

**Tests that must stay green**:
- `agent-loop.test.ts` — all ~3158 LOC. Priority cases: abort-before-first-iteration, abort-mid-tool-call, abort-during-retry-backoff, token-budget-exceeded-post-adapter, max-iterations.
- `agent-loop-guardrails.test.ts` — all 10 tests, all three phases.
- `agent-loop-hooks.test.ts` — onIterationStart/onIterationEnd/onToolCall/onCost order + `done` flag.
- `agent-loop-status.test.ts` — `_status` transitions (still written by `run()`, not IterationRunner).
- `span-enrichment.test.ts` — iteration span attributes (toolCount, errorCategory, adapter_retry with error attr).

### Step 4 — `run()` shrink to <120 LOC + deprecated-static cleanup (v2 rewrite)

**v2 change (critic §1 / edit #1)**: **factory-only public surface dropped from Wave-5B.** Lead decision on OQ4: defer to Wave-5C (its explicit charter is "Package boundaries & API 1.0-rc" per `decisions.md`). Codemod dropped entirely.

**Edits**:
- `run()` shrinks to <120 LOC: re-entrancy guard (L442-L448) + one-time no-pipeline warn (L454-L467) + external signal wiring (L477-L495) + `startTrace` (L499) + IterationContext construction + `while(true)` loop + pre-iteration emitTerminal helper + outcome dispatch + `finally` cleanup. Nothing else.
- Delete `AgentLoop.categorizeAdapterError` static (L1162-L1165) — M-7. Lead-confirmed delete (OQ1). The public `categorizeAdapterError` from `error-classifier.js` (already exported at `core/index.ts:85`) is the sole entry point.
- **KEEP `AgentLoop` as runtime value export** in `core/index.ts:44` and `index.ts:15`. **KEEP** the `@deprecated` doc-comment on the class (it's still accurate guidance — prefer the factory — but the class stays a runtime export).
- **NO codemod**: `new AgentLoop(...)` sites in `resilience.ts:89`, `resilience.test.ts:522,557,582`, `orchestration/agent-pool.ts`, `orchestration/__tests__/*`, `preset/src/index.ts:10,414`, examples — **all unchanged**.
- `@harness-one/core` public surface unchanged in Wave-5B. Wave-5C will own the hide (factory-only export + api-extractor gate).

**Tests that must stay green**: all 3780+. No behaviour change, no code motion outside `agent-loop.ts` + the three new files + `guardrail-helpers.ts` + deletion of the static + `ExecutionStrategy` type tightening.

## 8. Open Questions (v2: all resolved)

All four v1 open questions have been answered by the lead. v2 adopts:

1. **OQ1 (categorizeAdapterError static)** — **DELETE**. Done in Step 3 edits; public export from `error-classifier.js` remains the sole entry point. No external callers per critic b4 grep.
2. **OQ2 (AdapterCaller retry ownership)** — **AdapterCaller owns retry** (confirmed). Implemented in Step 2; Step 1 is a transitional `callOnce` single-attempt scope.
3. **OQ3 (mutable context)** — **ACCEPTED WITH CONSTRAINT**. Per v2 §2.3 invariant: ALL per-run mutable state on `IterationContext`, which is freshly allocated per `run()`. No mutable boxes on `IterationRunnerConfig`. IterationRunner is stateless across runs.
4. **OQ4 (factory-only public surface)** — **DEFERRED to Wave-5C** per its charter. Step 4 scope reduced accordingly (v2 §7 Step 4).

No new open questions remain.

## 9. Risks / What Could Break

### R1 · Stream error yield-order asymmetry (HIGH → MITIGATED)

Today: `handleStream` yields `{type:'error'}` at L1138; caller at L639 sees `null` + reads side-channel. Observer sees ONE error per failed stream.

v2: StreamHandler yields the error before returning `{ok:false, ...}`. AdapterCaller MUST NOT re-yield on stream path. On chat path, AdapterCaller does NOT yield (the caught error is wrapped by IterationRunner's bailOut). The asymmetry is explicit in §2.1 interface JSDoc + §4 `ErrorBail.errorAlreadyYielded` discriminator.

**Mitigation**: Step 2 gating test "exactly one `{type:'error'}` event per failed stream across all retries" — see §7 Step 2. Without this test the double-yield regression risk is silent.

### R2 · Abort propagation during backoff (MEDIUM → MITIGATED)

Today L622-L630: abort re-checked at top of each retry attempt; `backoff()` rejects with AbortedError, catch at L655 swallows, next iteration's abort check fires.

v2: AdapterCaller owns backoff + retry. Abort during backoff → AdapterCaller returns `{ok:false, errorCategory:'ABORTED'}` (synthetic category). IterationRunner maps to `bailOut(ErrorBail{reason:'aborted', errorEvent:AbortedError})`.

**Mitigation**: explicit 'ABORTED' category in AdapterCaller; existing `resilience.test.ts` "abort during backoff between retries" test must pass.

### R3 · Guardrail hook firing order (MEDIUM → MITIGATED)

Today: input hook L587 before span toolCount enrichment; output hook L799 before message yield; tool_output L954 after tool_result event and before conversation push.

v2: `runIteration` step order [1]→[2]→[5]→[6] preserves this exactly.

**Mitigation**: `agent-loop-guardrails.test.ts` asserts event-sequence equality. Additional gating tests: input-block → no iteration_start span toolCount; output-block → no message event between guardrail_blocked and error.

### R4 · `strategyOptions` re-allocation (LOW → MITIGATED)

PERF-025 L330-L344: frozen options bag reused across iterations. v2: passed as `Readonly<>` via `IterationRunnerConfig`; constructed once in AgentLoop constructor; IterationRunner passes by reference, no clone. `ExecutionStrategy.execute` `options` tightened to `Readonly<>` (M-5).

### R5 · `iterationSpanId` leak on throw (LOW → MITIGATED, v2 clarified)

Today L1019-L1020: `finally` closes open span.

v2: `ctx.iterationSpanId` is a field on `IterationContext`. **`run()`'s outer `finally` reads `ctx.iterationSpanId`** (critic lower — ctx outlives runIteration). Inside `runIteration`, `endSpan` helper nullifies `ctx.iterationSpanId` after success to prevent double-close from the outer finally.

**Mitigation**: `agent-loop-status.test.ts` "generator closed externally via return() mid-iteration" test covers this path.

### R6 · Helper relocation (LOW → MITIGATED)

`findLatestUserMessage` + `pickBlockingGuardName` move to `guardrail-helpers.ts`. No import cycle: helpers depend only on `pipeline.ts` + `types.ts`. Confirmed zero external callers of the static forms (critic lower + b4 grep).

### R7 · Test churn from factory migration (LOW → DEFERRED)

v2: not applicable. Step 4 no longer does a codemod (deferred to Wave-5C).

### R8 · IterationRunner re-entrancy (LOW → MITIGATED, v2)

v1 left this ambiguous ("runner reusable across iterations and across runs"). v2 §2.3 invariant: **IterationRunner holds no per-run state on its closure; all mutable state lives on IterationContext, freshly allocated per run()**. Across-runs reuse is safe because there's nothing to reset. Re-entrancy within the same run is still prevented by the re-entrancy guard on `AgentLoop.run()` (L442-L448).

### R9 · Cross-run state leak via IterationRunner reuse (NEW, v2, critic edit #7)

**Failure mode**: if `IterationRunner` held any per-run state on its closure (e.g. v1's `cumulativeUsage` on config, or v1's `toolCallCounter`), a second `run()` on the same `AgentLoop` would observe leftover state from the first.

**Mitigation (chosen)**: v2 §2.3 invariant — IterationRunner is stateless across runs; `IterationContext` owns ALL mutable state and is freshly allocated per `run()`. This is enforced STRUCTURALLY by the interface shapes (`IterationRunnerConfig` carries no mutable boxes; `IterationContext` carries all). Any future edit that adds a mutable field to `IterationRunnerConfig` must update this risk entry.

**Alternative rejected**: constructing a fresh `IterationRunner` per `run()` — works, but pays allocation cost per run when a single reusable instance suffices. The stateless-runner invariant achieves the same safety with no overhead.

---

## Appendix · Defence Against Likely Critic Challenges (v2 revised)

- **"Why is AdapterCaller a generator if only the streaming path yields?"** — Because the caller (run() in Step 2, IterationRunner in Step 3) must `yield*` it uniformly; a mixed callable/generator API forces a branch at the wrong layer. The chat path's generator body yields zero events; Node's async-generator delegation adds a small constant number of microtasks per empty-yielding call (~2). At one invocation per iteration × typical loops of <10 iterations, this is not a measurable cost. **Critic lower concern (§2.1)**: the phrasing "negligible" was imprecise in v1; corrected here to "small constant overhead, uninteresting at iteration granularity".

- **"Why expose `onRetry` instead of passing TraceManager into AdapterCaller?"** — Because AdapterCaller should not know about tracing. The callback is minimal. v2 adds `errorPreview` (critic §3) to preserve today's chat-path `error` span attribute without leaking TraceManager.

- **"Why not merge `IterationRunner.bailOut` with a top-level `run()` helper?"** — Because the pre-iteration checks in `run()` (abort, max_iterations, pre-call token budget) happen BEFORE iterationSpanId exists; they're structurally different from mid-iteration bails. Two tiny helpers in proper scopes beat one leaky helper crossing layers.

- **"`IterationContext` mutation is an anti-pattern."** — v2 owns the trade-off. **v1's "avoids allocation per iteration" defence is STRUCK**; today's baseline is closure-scoped `let`, not boxes. v2 adopts mutation because (a) it matches today's inline r/w pattern for `iterationSpanId`, `cumulativeStreamBytes`, etc., (b) keeps the `runIteration` signature compact (one parameter), (c) allows `run()`'s outer finally to read `ctx.iterationSpanId` for cleanup (R5 mitigation). The alternative (immutable context + return-all-deltas) would force `IterationOutcome` to carry 5+ extra fields on every iteration. Mutation loses static immutability but is **localized**: only `runIteration` and its private helpers mutate; `run()` only reads.

- **"What if StreamAggregator throws synchronously inside `handleChunk`?"** — StreamAggregator generators yield or throw. Today's L1147 catch catches both adapter-stream throws and aggregator throws. StreamHandler MUST wrap the `for-await-of` in the same try/catch and surface either as `{ok:false, errorCategory: categorizeAdapterError(err)}`. Documented in `handle()` JSDoc.

- **"`BailOutInput` tagged variants are over-engineering."** — v2 rejects this defence. Per critic §5, the optional-bag accepted nonsensical combinations (e.g. `{reason:'end_turn', errorEvent:foo}`) and could not prevent the original M-4 class of bug ("guardrail bail forgot to abort"). The tagged union adds ~20 LOC of type definition and eliminates a real class of future bugs; net win.
