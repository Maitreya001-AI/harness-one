# Wave-5B ADR · AgentLoop 3-Module Decomposition

**Status**: Proposed (Round 1, competing)
**Architect**: solution-architect
**Date**: 2026-04-15
**Depends on**: Wave-5A (merged) · **Invariants**: `decisions.md` (1.0-rc, fail-closed, no back-compat)

---

## 1. Context

`packages/core/src/core/agent-loop.ts` is 1268 LOC, with `AgentLoop.run()` spanning L436–L1032 — a ~600-LOC async generator that braids together iteration control, adapter calls, streaming translation, retry-with-backoff, guardrail hook points (input L587–L612 / tool_output L948–L978 / output L794–L821), per-iteration tracing, hook dispatch, and six duplicated abort/span/done triplets. The `this._lastStreamErrorCategory` instance side-channel (L246, set at L1149, read at L643–L644) is the worst offender: it breaks concurrency, obscures testability, and conflates `handleStream`'s return type. Wave-5A just hardened the three guardrail hook points; Wave-5B must decompose the god-method without disturbing any of them.

## 2. Decision — Three Modules

### Boundary rationale (answering "why not 2? why not 4?")

- **2 modules** (e.g. merge AdapterCaller + StreamHandler) fails the brief's explicit M-4 requirement: the streaming path is the *only* place the error-category side-channel exists, so isolating streaming as its own module is non-negotiable. Collapsing it into AdapterCaller also brings 280+ LOC of streaming machinery into the retry loop, defeating the goal of a <120-LOC `run()`.
- **4 modules** (e.g. split retry/backoff into its own module) sounds clean but `backoff()` is 37 lines of pure timer-plus-abort logic — extracting it into a whole module pays no boundary dividend. It lives naturally as a private helper on AdapterCaller, where its only caller is.
- **The chosen split is the minimal cut** that (a) eliminates the side-channel, (b) makes `run()` orchestration-only, and (c) localizes retry policy behind AdapterCaller so IterationRunner never mentions `attempt`.

### 2.1 `AdapterCaller` (new file: `packages/core/src/core/adapter-caller.ts`)

**Responsibility** — Execute one adapter turn (streaming or non-streaming) with retry-with-backoff and return a unified discriminated result; it never yields events directly to the consumer, only delivers them via the StreamHandler it delegates to.

**Public interface** (exact):

```ts
export interface AdapterCallOk {
  readonly ok: true;
  readonly message: Message;
  readonly usage: TokenUsage;
  /** 0 on the non-streaming path; aggregator.bytesRead on the streaming path. */
  readonly bytesRead: number;
  /** Streaming-only passthrough events already yielded by StreamHandler to the caller. */
  readonly path: 'chat' | 'stream';
  /** How many retries we burned getting here (for span attribution). */
  readonly attempts: number;
}
export interface AdapterCallFail {
  readonly ok: false;
  readonly error: HarnessError | Error;
  readonly errorCategory: string;
  readonly path: 'chat' | 'stream';
  readonly attempts: number;
}
export type AdapterCallResult = AdapterCallOk | AdapterCallFail;

export interface AdapterCallerConfig {
  readonly adapter: AgentAdapter;
  readonly tools?: readonly ToolSchema[];
  readonly streaming: boolean;
  readonly signal: AbortSignal;                    // from IterationRunner (= loop's internal abortController.signal)
  readonly maxAdapterRetries: number;
  readonly baseRetryDelayMs: number;
  readonly retryableErrors: readonly string[];
  readonly maxStreamBytes: number;
  readonly maxToolArgBytes: number;
  readonly maxCumulativeStreamBytes: number;
  readonly streamHandler: StreamHandler;            // injected; see §2.2
  /** Called each time a retry is decided, BEFORE the backoff sleep. Enables span event attribution without importing trace types here. */
  readonly onRetry?: (info: { attempt: number; errorCategory: string; path: 'chat' | 'stream' }) => void;
}

export interface AdapterCaller {
  /**
   * Execute one adapter turn. On the streaming path the generator yields
   * text_delta / tool_call_delta / warning / error events to the consumer
   * (same variants StreamHandler already produces). On the non-streaming
   * path nothing is yielded — only the return value is used.
   *
   * The retry loop lives INSIDE this method. Callers never see attempt
   * numbers. Abort/backoff-abort is surfaced as ok:false with
   * errorCategory='ABORTED' so IterationRunner can bailOut uniformly.
   */
  call(
    conversation: readonly Message[],
    cumulativeStreamBytesSoFar: number,
  ): AsyncGenerator<AgentEvent, AdapterCallResult>;
}

export function createAdapterCaller(config: Readonly<AdapterCallerConfig>): AdapterCaller;
```

**State it owns** — None as instance fields (factory closure only). Retry attempt counter is a local `let`. This is deliberate: every adapter turn is self-contained; there is nothing to persist between turns.

**What it explicitly does NOT own**:
- Guardrail pipelines (hook points live in IterationRunner, fired *around* `call`).
- TraceManager / span handles (tracing is IterationRunner's concern; retries surface via `onRetry` callback).
- Conversation mutation (it receives `readonly Message[]`).
- Iteration counters, cumulative usage, hook dispatch.
- AbortController ownership — it only holds an `AbortSignal`. Aborting is IterationRunner's job.

### 2.2 `StreamHandler` (new file: `packages/core/src/core/stream-handler.ts`)

**Responsibility** — Translate one call to `adapter.stream()` into a sequence of `AgentEvent`s, accumulate via `StreamAggregator`, and return a discriminated union reporting success or categorized failure. **This replaces the current `AgentLoop.handleStream` (L1106–L1160) and eliminates `_lastStreamErrorCategory`.**

**Public interface** (exact):

```ts
export type StreamResult =
  | { readonly ok: true; readonly message: Message; readonly usage: TokenUsage; readonly bytesRead: number }
  | { readonly ok: false; readonly error: HarnessError | Error; readonly errorCategory: string };

export interface StreamHandlerConfig {
  readonly adapter: AgentAdapter;           // `adapter.stream` must be defined — caller's responsibility to check
  readonly tools?: readonly ToolSchema[];
  readonly signal: AbortSignal;
  readonly maxStreamBytes: number;
  readonly maxToolArgBytes: number;
  readonly maxCumulativeStreamBytes: number;
}

export interface StreamHandler {
  /**
   * Consume one adapter.stream() call.
   *
   * YIELDS: text_delta | tool_call_delta | warning | error (NOT guardrail_blocked, NOT iteration_start, NOT done).
   * RETURNS: StreamResult — the caller decides what to do with {ok:false}.
   *
   * The `error` AgentEvent is yielded JUST BEFORE returning {ok:false}, preserving
   * the historical observer-visible event stream. AdapterCaller MUST NOT re-emit.
   */
  handle(
    conversation: readonly Message[],
    cumulativeStreamBytesSoFar: number,
  ): AsyncGenerator<AgentEvent, StreamResult>;
}

export function createStreamHandler(config: Readonly<StreamHandlerConfig>): StreamHandler;
```

**State it owns** — None externally-visible. Each `handle()` invocation constructs a fresh `StreamAggregator` (preserves today's per-iteration semantics at L1111). The handler is stateless across calls → trivially safe to reuse.

**What it explicitly does NOT own**:
- Retry decisions (AdapterCaller's `retryableErrors.includes(errorCategory)` logic).
- The instance-field side-channel — **deleted**. Error category travels on the return value, not a field.
- Guardrails, tracing, hooks, conversation building.

### 2.3 `IterationRunner` (new file: `packages/core/src/core/iteration-runner.ts`)

**Responsibility** — Run exactly one agent iteration: pre-call budget/abort checks, input-guardrail, adapter call (delegated), post-call abort/budget re-check, output-guardrail on no-tool-calls, tool execution via `ExecutionStrategy`, tool_output guardrails per result, conversation mutation. Owns the `bailOut` helper that pairs abort + span end + event emit + done event for every terminal branch.

**Public interface** (exact):

```ts
export type IterationOutcome =
  | { readonly kind: 'continue' }                              // another iteration should run
  | { readonly kind: 'terminated'; readonly reason: DoneReason }; // done event already emitted

export interface IterationContext {
  /** Caller-owned mutable conversation buffer. IterationRunner pushes assistant + tool messages into it. */
  readonly conversation: Message[];
  /** 1-based iteration counter, pre-incremented by the orchestrator. */
  readonly iteration: number;
  /** Cumulative stream bytes across prior iterations; IterationRunner returns the updated value via ctx mutation. */
  cumulativeStreamBytes: { value: number };
  /** Active iteration span id; IterationRunner manages endSpan calls on terminal branches. */
  iterationSpanId: string | undefined;
  /** Trace id for starting child tool spans. */
  readonly traceId: string | undefined;
}

export interface IterationRunnerConfig {
  readonly adapterCaller: AdapterCaller;
  readonly executionStrategy: ExecutionStrategy;
  readonly strategyOptions: Readonly<{
    readonly signal: AbortSignal;
    readonly getToolMeta?: (name: string) => { sequential?: boolean } | undefined;
  }>;
  readonly abortController: AbortController;     // IterationRunner aborts via this in bailOut
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly toolTimeoutMs?: number;
  readonly maxTotalTokens: number;
  readonly maxIterations: number;
  readonly inputPipeline?: GuardrailPipeline;
  readonly outputPipeline?: GuardrailPipeline;
  readonly traceManager?: AgentLoopTraceManager;
  readonly hooks: readonly AgentLoopHook[];
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** Mutable accumulator — updated in place so orchestrator sees cumulative usage without an extra return slot. */
  readonly cumulativeUsage: { inputTokens: number; outputTokens: number };
  /** Mutable counter. */
  readonly toolCallCounter: { value: number };
  /** Invoked when IterationRunner decides the loop is done. Returns the `done` AgentEvent (pre-built by orchestrator so `_status` mutation stays with AgentLoop). */
  readonly buildDoneEvent: (reason: DoneReason) => AgentEvent;
}

export interface IterationRunner {
  runIteration(ctx: IterationContext): AsyncGenerator<AgentEvent, IterationOutcome>;
}

export function createIterationRunner(config: Readonly<IterationRunnerConfig>): IterationRunner;
```

**State it owns** — Nothing durable. All mutable state (conversation, cumulative usage, tool-call counter, iterationSpanId, cumulativeStreamBytes) is passed via `IterationContext` or config-level mutable boxes. The runner itself is reusable across iterations and across runs.

**What it explicitly does NOT own**:
- The `while(true)` orchestration loop — that stays in `AgentLoop.run()` (<120 LOC).
- `_status` transitions, external signal listener attach/detach, the one-time no-pipeline warning, re-entrancy guard — these stay in `run()`.
- Trace/span creation at the *run* level (`startTrace`, the finally-block `endTrace`).
- Adapter selection, streaming-vs-chat dispatch — delegated entirely to AdapterCaller.

## 3. Sequence (one iteration)

```
AgentLoop.run() orchestrator
 │
 │  ── pre-checks: isAborted? iteration > max? cumulative token budget?
 │       (each → bailOut(reason) via IterationRunner helper, or run() inlines — see §4)
 │  ── prune conversation if > maxConversationMessages
 │  ── startSpan(iteration-N), setSpanAttributes
 │  ── yield { type: 'iteration_start', iteration }
 │  ── runHook('onIterationStart', ...)
 │
 ▼
IterationRunner.runIteration(ctx)
 │
 │  [1] if inputPipeline → runInput(latestUser)
 │       ├─ passed → continue
 │       └─ blocked → bailOut('error', {guardrail: 'input', name, reason})
 │                    emits: guardrail_blocked + error + done('error')
 │                    aborts: abortController
 │
 │  [2] yield* adapterCaller.call(conversation, cumulativeStreamBytes)
 │       │
 │       ▼
 │      AdapterCaller.call()
 │       ├─ loop attempt = 0..maxAdapterRetries:
 │       │    if streaming:
 │       │       result = yield* streamHandler.handle(...)
 │       │       if result.ok → return {ok:true, ...result, path:'stream', attempts}
 │       │       if retryable(result.errorCategory) && attempt < max → onRetry; backoff(); continue
 │       │       else → return {ok:false, error: result.error, errorCategory, path:'stream', attempts}
 │       │    else:
 │       │       try { resp = await adapter.chat(...) } → return {ok:true, ...resp, path:'chat', attempts}
 │       │       catch err →
 │       │          errorCategory = categorizeAdapterError(err)
 │       │          if retryable && attempt < max → onRetry; backoff(); continue
 │       │          else → return {ok:false, error: err, errorCategory, path:'chat', attempts}
 │       │  (backoff() rejects on abort → caught by retry loop which re-checks abort next iter)
 │       │
 │      returns AdapterCallResult
 │
 │       if !result.ok → bailOut('error', {error: result.error, category, path})
 │                       emits: error + done('error')
 │
 │       cumulativeStreamBytes += result.bytesRead
 │       setSpanAttributes({inputTokens, outputTokens, toolCount, path: result.path})
 │       hook('onCost', ...); clampAndAccumulate(cumulativeUsage)
 │
 │  [3] post-call abort check → bailOut('aborted') if signal fired mid-call
 │  [4] post-call token budget check → bailOut('token_budget') if exceeded
 │
 │  [5] toolCalls = assistantMsg.role === 'assistant' ? assistantMsg.toolCalls : undefined
 │       if no toolCalls:
 │          if outputPipeline → runOutput(finalContent)
 │             blocked → bailOut('error', {guardrail: 'output'})
 │          yield { type:'message', message, usage }
 │          fireIterationEnd(true); endSpan('completed')
 │          return { kind:'terminated', reason:'end_turn' }
 │
 │  [6] conversation.push(assistantMsg)
 │       for tc of toolCalls: yield { type:'tool_call', ... }; hook('onToolCall', ...)
 │       executionResults = await executionStrategy.execute(toolCalls, handler, strategyOptions)
 │       for r of executionResults:
 │          yield { type:'tool_result', ... }
 │          resultContent = serialize(r)
 │          if outputPipeline → runToolOutput(resultContent, toolName)
 │             blocked → yield guardrail_blocked (phase:'tool_output'); rewrite content to stub
 │                       (NOTE: loop continues — same as today L948-L978)
 │          conversation.push(toolResultMsg)
 │
 │  [7] post-tools abort check → bailOut('aborted')
 │  [8] fireIterationEnd(false); endSpan('completed')
 │      return { kind:'continue' }
 │
 ▼
run() orchestrator
 │  switch outcome.kind:
 │     'continue' → next iteration
 │     'terminated' → break loop (done event already emitted by bailOut/normal path)
```

## 4. `bailOut(reason)` Contract

**The unifier for today's six-duplicated abort/span/event triplet.** Every terminal branch in the current `run()` does some permutation of:

```
abortController.abort()  // sometimes
endSpan(spanId, 'error') // always when span open
yield { type: 'error', error }  // sometimes
fireIterationEnd(true)   // always
yield doneEvent(reason)  // always
return
```

This is the bug surface. We replace it with ONE private generator helper on IterationRunner:

```ts
// Private to IterationRunner — NOT exported.
interface BailOutInput {
  readonly reason: DoneReason;
  /** When provided, yielded BEFORE doneEvent. Omit for pure-termination (e.g. end_turn with no error). */
  readonly errorEvent?: Extract<AgentEvent, { type: 'error' }>;
  /** When provided (input / output / tool_output guardrail), yielded BEFORE errorEvent. */
  readonly guardrailEvent?: Extract<AgentEvent, { type: 'guardrail_blocked' }>;
  /** When true, abortController.abort() is called before any yield. Used for guardrail blocks and internal aborts. */
  readonly abort?: boolean;
  /** When true, `message` is yielded BEFORE the error — needed for token_budget-exceeded after a successful adapter call (preserves L780). */
  readonly messageEvent?: Extract<AgentEvent, { type: 'message' }>;
  /** Controls span end status. Defaults to 'error' for reason !== 'end_turn'. */
  readonly spanStatus?: 'completed' | 'error';
}

private async *bailOut(
  ctx: IterationContext,
  input: BailOutInput,
): AsyncGenerator<AgentEvent, IterationOutcome> {
  if (input.abort) this.config.abortController.abort();
  if (input.messageEvent) yield input.messageEvent;
  if (input.guardrailEvent) yield input.guardrailEvent;
  if (input.errorEvent) yield input.errorEvent;
  if (ctx.iterationSpanId && this.config.traceManager) {
    const status = input.spanStatus ?? (input.reason === 'end_turn' ? 'completed' : 'error');
    try { this.config.traceManager.endSpan(ctx.iterationSpanId, status); } catch { /* already ended */ }
    ctx.iterationSpanId = undefined;
  }
  this.fireIterationEnd(ctx.iteration, true);
  yield this.config.buildDoneEvent(input.reason);
  return { kind: 'terminated', reason: input.reason };
}
```

**Call sites it replaces** (line ranges in today's `run()`):

| Today | Replacement |
|---|---|
| L507–L513 (pre-check abort) | stays in `run()` orchestrator (before IterationRunner); but `run()` uses a tiny inlined helper with same shape to keep symmetry |
| L519–L526 (max_iterations) | stays in `run()` orchestrator |
| L530–L537 (pre-call token budget) | stays in `run()` orchestrator |
| L587–L612 (input guardrail block) | **IterationRunner.bailOut({reason:'error', abort:true, guardrailEvent, errorEvent})** |
| L624–L629 (mid-retry abort) | handled inside AdapterCaller → returns {ok:false, errorCategory:'ABORTED'} → IterationRunner.bailOut({reason:'aborted', errorEvent:AbortedError}) |
| L661–L673 (stream retries exhausted) | AdapterCaller returns {ok:false}; IterationRunner.bailOut({reason:'error', errorEvent}) |
| L711–L730 (chat retries exhausted) | same path as above |
| L735–L741 (unreachable safety) | preserved — IterationRunner short-circuits with bailOut({reason:'error'}) |
| L757–L763 (post-adapter abort) | **IterationRunner.bailOut({reason:'aborted', errorEvent:AbortedError})** |
| L778–L787 (post-call token budget) | **IterationRunner.bailOut({reason:'token_budget', messageEvent, errorEvent:TokenBudgetExceededError})** |
| L794–L820 (output guardrail on final) | **IterationRunner.bailOut({reason:'error', abort:true, guardrailEvent, errorEvent})** |
| L822–L827 (end_turn happy path) | IterationRunner returns {kind:'terminated', reason:'end_turn'} after yielding `message` + endSpan('completed') + fireIterationEnd(true) directly (not via bailOut — bailOut is error-shaped) — OR via bailOut({reason:'end_turn', messageEvent, spanStatus:'completed'}) for uniformity. **Decision: use bailOut for uniformity.** |
| L988–L995 (post-tools abort) | **IterationRunner.bailOut({reason:'aborted', errorEvent:AbortedError})** |

Result: 9 of the 11 sites collapse into one code path. Pre-check sites stay in `run()` because they happen *before* a span opens and *before* IterationRunner is called — duplicating them into IterationRunner would just push complexity around. `run()` keeps a tiny private `emitTerminal(reason, errorEvent?)` for those three, ~15 LOC total. Net reduction: ~75 LOC of branch duplication → ~35 LOC of structured helpers.

## 5. Discriminated Union for Stream Result — No Side-Channel

The type is already listed in §2.2. The consumption pattern in IterationRunner (indirectly, through AdapterCaller):

```ts
// inside AdapterCaller.call() streaming branch — replaces today's L634-L673
const streamResult = yield* this.config.streamHandler.handle(conversation, cumulativeStreamBytesSoFar);
if (streamResult.ok) {
  return { ok: true, message: streamResult.message, usage: streamResult.usage,
           bytesRead: streamResult.bytesRead, path: 'stream', attempts: attempt };
}
// streamResult.ok === false — TypeScript narrows errorCategory to string
if (this.config.retryableErrors.includes(streamResult.errorCategory) && attempt < this.config.maxAdapterRetries) {
  this.config.onRetry?.({ attempt, errorCategory: streamResult.errorCategory, path: 'stream' });
  try { await this.backoff(attempt); } catch { /* aborted during backoff */ }
  continue;
}
return { ok: false, error: streamResult.error, errorCategory: streamResult.errorCategory,
         path: 'stream', attempts: attempt };
```

**Key invariants**:
1. **No instance field.** `StreamHandler.handle` is a pure function-of-inputs; no field survives the call.
2. **Category travels with the error.** The old pattern (`null` return + `_lastStreamErrorCategory` read → reset) is replaced by destructuring the discriminated union.
3. **The `error` AgentEvent is still yielded.** `StreamHandler` yields `{type:'error', error}` on the failure path before returning `{ok:false, ...}` — observer-visible behaviour is identical to today's L1138–L1156.
4. **Concurrency-safe.** Two in-flight streams on independent handlers no longer collide on a shared field. (Re-entrancy guard on AgentLoop stays as defense-in-depth.)

Delete `AgentLoop._lastStreamErrorCategory` (L246) and the read/reset at L643–L644.

## 6. Wave-5A Guardrail Integration — Where Each Hook Lives

| Hook | Today (agent-loop.ts) | After decomposition |
|---|---|---|
| **input** — `runInput` before adapter call | L587–L612, inline in `run()` | `IterationRunner.runIteration` step [1], BEFORE `adapterCaller.call`. Uses same `findLatestUserMessage` + `pickBlockingGuardName` helpers (now exported from a new tiny `packages/core/src/core/guardrail-helpers.ts` to avoid the static-method-on-deprecated-class anti-pattern). |
| **tool_output** — `runToolOutput` after each tool result | L954–L977, inline in `run()` | `IterationRunner.runIteration` step [6], inside the `for (execResult of executionResults)` loop. Rewrites `resultContent` into the GUARDRAIL_VIOLATION stub; loop continues. |
| **output** — `runOutput` on final assistant answer | L799–L820, inline in `run()` | `IterationRunner.runIteration` step [5], BEFORE yielding the final `{type:'message'}` event when `toolCalls` is empty/absent. |

**All three firing semantics are preserved verbatim**:
- input-block → `abortController.abort()` + `guardrail_blocked(phase:'input')` + `error(GUARDRAIL_VIOLATION)` + `done('error')` — via `bailOut({abort:true, guardrailEvent, errorEvent, reason:'error'})`.
- output-block → same triplet with `phase:'output'` — same `bailOut` shape.
- tool_output-block → `guardrail_blocked(phase:'tool_output')` + stub rewrite + loop continues (no bailOut, no abort).

**Classifier preservation**: `categorizeAdapterError` in `error-classifier.ts` already returns `'GUARDRAIL_VIOLATION'` for `HarnessError(code='GUARDRAIL_VIOLATION')` (L33–L35). The default `retryableErrors` is `['ADAPTER_RATE_LIMIT']`. AdapterCaller does `retryableErrors.includes(errorCategory)` — GUARDRAIL_VIOLATION never matches → non-retryable. **This invariant survives trivially because AdapterCaller uses the exact same `.includes` check**; no code changes needed to preserve it.

**Wave-5A tests** (`packages/core/src/core/__tests__/agent-loop-guardrails.test.ts`, 326 LOC, 10+ tests) — unchanged; they assert the event sequence at the `run()` consumer boundary, which is identical.

## 7. Migration Plan — 4 Incremental TDD Steps

Each step leaves the full test suite green before the next starts. All 3780+ tests must pass after each step, not just the final one.

### Step 1 — Extract `AdapterCaller` (adapter call + retry, NON-streaming path only)

**Rationale for starting here**: smallest, cleanest extraction. Streaming path still calls the old `handleStream` (still inlined). The retry loop over `adapter.chat` moves out.

**Edits**:
- New file: `adapter-caller.ts` — implements only the `streaming:false` branch of `call()`.
- In `agent-loop.ts`: delete L675–L733 (non-streaming attempt loop inside `run()`); replace with `const result = yield* this.adapterCaller.call(conversation, cumulativeStreamBytes)` and a narrow `if (!result.ok)` bailOut.
- Streaming branch (L632–L674) still uses `this.handleStream` + `_lastStreamErrorCategory` — deferred to Step 2.
- `AgentLoop` constructor instantiates `createAdapterCaller({...})` and stashes in a new `private readonly adapterCaller`.
- `onRetry` callback wires to the existing `tm.addSpanEvent(iterationSpanId, {name:'adapter_retry', ...})` call site.

**Tests that must stay green**:
- `agent-loop.test.ts` — all 30+ non-streaming tests, especially "retries on rate-limit" / "surfaces adapter error after retries exhausted".
- `resilience.test.ts` (602 LOC) — all retry/backoff tests.
- `error-classifier.test.ts` — untouched but regression check.

### Step 2 — Extract `StreamHandler`, add discriminated union, delete `_lastStreamErrorCategory`

**Rationale**: this is the headline fix (M-4). Delivered as one atomic change — introducing the union while the field still exists would be half-measure churn.

**Edits**:
- New file: `stream-handler.ts` — owns the body of today's `handleStream` L1106–L1160 but returns `StreamResult` instead of `null`.
- Extend `AdapterCaller` (created in Step 1) with the streaming branch: inject `streamHandler` via config; `call()` now branches on `this.config.streaming`.
- Delete `AgentLoop.handleStream` method, `AgentLoop._lastStreamErrorCategory` field (L246), and the `null`-return retry block at L634–L674 — the behaviour is now inside AdapterCaller.
- `AgentLoop` constructor: `createStreamHandler({adapter, tools, signal: abortController.signal, maxStreamBytes, maxToolArgBytes, maxCumulativeStreamBytes: maxIterations * maxStreamBytes})` → pass to `createAdapterCaller`.

**Tests that must stay green**:
- `streaming-errors.test.ts` (448 LOC) — the critical suite. Cases include stream-time rate-limit → retry → succeed, retries exhausted on network error, non-retryable auth error, abort during stream, size-limit exceeded mid-stream.
- `agent-loop.test.ts` streaming tests (L569+ — ~15 tests).
- `stream-aggregator.test.ts` — StreamAggregator API unchanged; sanity.
- `span-enrichment.test.ts` — the `adapter_retry` span event must still fire with `path:'stream'` attribute; `onRetry` callback preserves this.

### Step 3 — Extract `IterationRunner` + `bailOut`

**Edits**:
- New file: `iteration-runner.ts`. Body is today's `run()` L506–L1001 minus the outer `while(true)` minus the pre-iteration checks (abort, max_iterations, pre-call token budget) minus the finally-block cleanup.
- Move L587–L612 (input), L794–L820 (output), L948–L978 (tool_output) inline inside `runIteration` — semantic no-op (same conversation, same pipelines, same pickBlockingGuardName helper, which moves to `guardrail-helpers.ts`).
- Introduce `bailOut` as private method; replace the 9 terminal sites per §4 table.
- `ExecutionStrategy.execute` in `types.ts` — tighten `options` to `Readonly<{...}>` (M-5). Current callsites all accept this; the only known implementations (`execution-strategies.ts` sequential + parallel) don't mutate `options`.
- Delete `AgentLoop.findLatestUserMessage`, `AgentLoop.pickBlockingGuardName`, `AgentLoop.categorizeAdapterError` static methods. `findLatestUserMessage` + `pickBlockingGuardName` move to `guardrail-helpers.ts`; `categorizeAdapterError` static already duplicated the public export (M-7) → just delete.

**Tests that must stay green**:
- `agent-loop.test.ts` — all ~3158 LOC. Especially: abort-before-first-iteration, abort-mid-tool-call, abort-during-retry-backoff, token-budget-exceeded-post-adapter, max-iterations.
- `agent-loop-guardrails.test.ts` — all 10 tests, all three phases.
- `agent-loop-hooks.test.ts` — `onIterationStart`/`onIterationEnd`/`onToolCall`/`onCost` firing order + `done` flag.
- `span-enrichment.test.ts` — iteration span attributes (iteration index, toolCount, errorCategory on failure, adapter_retry events).

### Step 4 — `run()` simplification + deprecated cleanup

**Edits**:
- `run()` shrinks to <120 LOC: re-entrancy guard, no-pipeline warn, external signal wiring, startTrace, the `while(true)` loop calling `iterationRunner.runIteration(ctx)` and dispatching on `IterationOutcome`, the finally block.
- Delete the class-level `@deprecated` doc-comment warnings on `AgentLoop` (decision: factory-only export at the public surface per brief §4).
- `packages/core/src/core/index.ts` L44: change `export { AgentLoop, createAgentLoop } from './agent-loop.js'` → `export { createAgentLoop } from './agent-loop.js'; export type { AgentLoop } from './agent-loop.js'` (type-only re-export so existing `AgentLoop` type references survive without exposing the constructor).
- `packages/core/src/index.ts` L15–L16: drop `AgentLoop` value export; keep `createAgentLoop`.
- Update existing tests that use `new AgentLoop({...})` to `createAgentLoop({...})` — this is a **big tranche** (~80 call sites across `agent-loop.test.ts` alone per b6 grep). Since the shape is identical, it's a sed-able edit; `issue-fixer` runs a codemod.

**Tests that must stay green**: all 3780+. The only code change in Step 4 is the public surface (factory-only) + the test edits to match. No behaviour change.

## 8. Open Questions (need user call)

1. **`categorizeAdapterError` deprecated static** (M-7): Step 3 proposes deleting `AgentLoop.categorizeAdapterError` (L1162–L1165) entirely. The public export from `error-classifier.ts` stays. Confirm this is acceptable given 1.0-rc allows breaking internal API? **Default**: delete.
2. **Does `AdapterCaller` own retry, or only a single attempt?** The ADR chose `owns retry` because that's where retry *policy* lives today (around the adapter call). Alternative: IterationRunner owns retry and calls a single-attempt `AdapterCaller.callOnce` in a loop. **Rationale for chosen side**: (a) retry is a property of the adapter boundary, not the iteration — moving it up pollutes IterationRunner with attempt counters; (b) backoff-during-abort handling is self-contained in AdapterCaller; (c) `onRetry` callback surfaces enough info for IterationRunner's span instrumentation. **Request confirmation** before Step 1.
3. **`IterationContext` vs more-arguments-to-runIteration**: the ADR threads a mutable `IterationContext` object. Alternative: runIteration returns updated values in `IterationOutcome`. Chose mutation for parity with today's inline reads/writes of `iterationSpanId`, `cumulativeStreamBytes` etc. — swapping to immutable would add allocation on the hot path. **Is mutable context acceptable**? Default: yes.
4. **`AgentLoop` class surface**: Step 4 proposes factory-only export, with `AgentLoop` still a class internally but type-only re-exported. Alternative: convert to a plain factory-returned object and drop the class entirely. Chose keep-class because private fields + status management + `dispose`/`abort` methods are ergonomic; the class stays an implementation detail not a public constructor. **Confirm**? Default: keep class internally, hide constructor from public API.

## 9. Risks / What Could Break — Specific Failure Modes

### R1 · Stream error yield order (HIGH)

Today: `handleStream` yields `{type:'error', error}` at L1138 when StreamAggregator emits an error; the caller at L639 sees `null` and re-reads the side-channel. The observer sees **one** error event per failed stream.

After: StreamHandler yields the error at the same point, then returns `{ok:false, ...}`. AdapterCaller must NOT yield a second error when it returns `{ok:false}`. **Mitigation**: AdapterCaller's non-streaming path yields `{type:'error'}` (because it caught the error itself), streaming path does NOT yield it again (StreamHandler already did). Explicitly asymmetric — document in AdapterCaller.call() JSDoc, add test in Step 2 asserting exactly one error event per stream failure.

### R2 · Abort propagation during backoff (MEDIUM)

Today L622–L630: at the top of each retry attempt, abort is re-checked AFTER the first attempt. Backoff rejects with AbortedError on signal fire; the catch at L655 swallows, falling through to the next iteration's abort check at L624.

After: AdapterCaller owns backoff + retry. If abort fires during backoff, AdapterCaller must return `{ok:false, errorCategory:'ABORTED'}` (new synthetic category) so IterationRunner knows to bailOut with reason='aborted' (not 'error'). **Mitigation**: explicit `ABORTED` category in AdapterCaller; IterationRunner maps it to `{reason:'aborted', errorEvent: new AbortedError()}`. Test coverage: "abort during backoff between retries" test in `resilience.test.ts` — must pass.

### R3 · Guardrail hook firing order (MEDIUM)

Today: input hook fires L587 — **before** iteration span attribute enrichment of toolCount (L746). Output hook fires L799 — **before** `{type:'message'}` yield. Tool_output hook fires L954 — **after** `tool_result` event and **before** `conversation.push`.

After: IterationRunner MUST preserve this exact ordering. `runIteration` step order [1]→[2]→[5]→[6] maintains it. **Mitigation**: the `agent-loop-guardrails.test.ts` suite asserts event-sequence equality; a single re-ordering breaks it. Also add an explicit ordering test: input-block → verify NO iteration_start span attributes for toolCount (i.e. block happens before adapter call); output-block → verify NO message event between guardrail_blocked and error.

### R4 · `strategyOptions` re-allocation (LOW-MEDIUM)

PERF-025 at L330–L344: the options bag is pre-frozen in the constructor and reused across iterations. IterationRunner receives it via config — reused by reference across `runIteration` calls. **Mitigation**: pass as `Readonly<>` through config; construct once in AgentLoop constructor; verify no clone-on-read in IterationRunner. The `ExecutionStrategy.execute` `options` type tightens to `Readonly<>` (M-5) — compile-time check.

### R5 · `iterationSpanId` leak on throw (LOW)

Today L1019–L1020: `finally` closes an open span. After decomposition, `runIteration` may return early via bailOut (which closes the span) but a thrown exception skips bailOut. **Mitigation**: `run()`'s outer `finally` block already handles this (stays unchanged). Additionally, add a try/finally inside `runIteration` that nullifies `ctx.iterationSpanId` AFTER endSpan succeeds to prevent double-close from the outer finally. Unit test: "generator closed externally via return() mid-iteration" — already covered by `agent-loop-status.test.ts`.

### R6 · Duplicated `findLatestUserMessage`/`pickBlockingGuardName` (LOW)

Move to `guardrail-helpers.ts` (new 40-LOC file). Mechanical. Risk: import cycle with `agent-loop.ts`? No — helpers depend only on `pipeline.ts` types + `types.ts`; `agent-loop.ts` imports helpers; no cycle.

### R7 · Test churn from `new AgentLoop` → `createAgentLoop` (LOW, but large)

~80 sites in `agent-loop.test.ts` alone. **Mitigation**: isolated to Step 4; is a mechanical rename. Run after Steps 1–3 are green so we don't compound risk.

### R8 · Re-entrancy of `runIteration` on the same instance (LOW)

IterationRunner is reusable; two concurrent `runIteration` calls would race on `IterationContext`. **Mitigation**: `AgentLoop.run()`'s re-entrancy guard at L442–L448 is the enforcement point; IterationRunner itself is stateless between calls, so a disciplined caller is safe. Document: "IterationRunner must not be called concurrently for the same IterationContext."

---

## Appendix · Defense Against Likely Critic Challenges

- **"Why is AdapterCaller a generator if only the streaming path yields?"** — Because the caller (IterationRunner) must `yield*` it uniformly; a mixed callable/generator API forces a branch at the wrong layer. The non-streaming path's generator body is trivially empty-yielding (`return {...}`), costing one extra async iterator tick — negligible.
- **"Why expose `onRetry` instead of passing TraceManager into AdapterCaller?"** — Because AdapterCaller should not know about tracing. The callback is the minimal interface needed to surface retry attempts for instrumentation. Keeps AdapterCaller testable without a TraceManager stub.
- **"Why not merge `IterationRunner.bailOut` with a top-level `run()` helper?"** — Because the pre-iteration checks in `run()` (abort, max_iterations, pre-call token budget) happen BEFORE iterationSpanId exists; they're structurally different. Two tiny helpers in their proper scopes beat one leaky helper crossing layers.
- **"The `IterationContext` mutation is ugly — why not return all deltas?"** — Trade-off accepted: mutation matches today's inline pattern, avoids allocation per iteration, and is contained (only IterationRunner writes the context; no external observer sees partial state because the generator is single-consumer).
- **"What if StreamAggregator throws synchronously inside `handleChunk`?"** — StreamAggregator generators can only yield or throw. Today's L1147 catch catches both adapter-stream throws and aggregator throws. StreamHandler MUST wrap the for-await-of in the same try/catch, surfacing either as `{ok:false, errorCategory: categorizeAdapterError(err)}`. Documented in `handle()` JSDoc.
