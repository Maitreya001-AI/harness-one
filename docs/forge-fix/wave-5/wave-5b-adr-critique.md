# Wave-5B ADR Critique · technical-critic

**Target**: `docs/forge-fix/wave-5/wave-5b-adr.md` (Round 1, competing)
**Reviewer**: technical-critic
**Date**: 2026-04-15
**Scope**: brief invariants, `agent-loop.ts` (1268 LOC), guardrail/streaming/resilience tests

---

## Verdict

**ACCEPT-WITH-CHANGES** — the three-module cut is sound and the migration ordering is defensible, but **four concrete issues must be fixed in the ADR before lock-in**. The most serious is that Step 4 (factory-only public surface) is not actually executable as written: `AgentLoop` is used as a runtime constructor value inside the core package itself (`resilience.ts:89`) and is spied on by `vi.spyOn(AgentLoop.prototype, 'dispose')` in the resilience test suite. A type-only re-export breaks both sites, so Step 4 either shrinks in scope or grows a second refactor the ADR has not budgeted for. The other three top concerns are (a) the `IterationContext` mutable-box pattern is a real regression from today's closure-scoped locals and the ADR's "parity / allocation" defence does not hold up, (b) `onRetry` is under-specified and cannot in fact replicate today's `adapter_retry` span event verbatim on the chat path, and (c) Step 1's intermediate state creates a half-hybrid instance (`AdapterCaller.call` for chat + `this.handleStream` + `_lastStreamErrorCategory` for stream) that a specific existing test exercises in the same instance-lifetime on `span-enrichment.test.ts` — the "tests stay green at every step" claim needs evidence or a revised Step 1 scope.

---

## Top 5 Concerns (ranked by impact)

### 1. [HIGH] Step 4 factory-only export is blocked by in-package and test-harness runtime uses of `AgentLoop`

**Claim**: The ADR claims (§7 Step 4) that `packages/core/src/core/index.ts` can switch to `export type { AgentLoop }` (type-only) and that the codemod is "~80 call sites across `agent-loop.test.ts`". This under-counts, because it only looked at the single-file grep of `agent-loop.test.ts`. Production code and other test suites use `AgentLoop` as a **runtime value**.

**Evidence**:
- `packages/core/src/core/resilience.ts:13` imports `AgentLoop` as a value, `:89` does `currentLoop = new AgentLoop(loopConfig)`. This is not test code — it ships in `harness-one/core` as the implementation of `createResilientLoop`. A type-only re-export fails the internal import *and* breaks the factory that the brief says must keep working.
- `packages/core/src/core/__tests__/resilience.test.ts:522,557,582` each contain `const { AgentLoop } = await import('../agent-loop.js'); vi.spyOn(AgentLoop.prototype, 'dispose')`. `vi.spyOn(proto, method)` requires `proto` to be a runtime object — a type-only re-export turns these tests red.
- `packages/core/src/orchestration/__tests__/agent-pool.test.ts:2,8` and `packages/core/src/orchestration/__tests__/integration.test.ts:5` also `new AgentLoop(...)` directly.
- `packages/core/src/index.ts:15` value-exports `AgentLoop` from the package root. The ADR only rewrites `core/index.ts` and misses this.
- Examples (`examples/orchestration/multi-agent.ts:7,18`, `examples/resilience/fallback-adapter.ts:8,39`) and `packages/preset/src/index.ts:10,414` instantiate `new AgentLoop(...)`.

**Required change**: Either (a) keep `AgentLoop` as a runtime export in Step 4 (drop the "factory-only public" goal for Wave-5B and punt it to Wave-5C package-boundaries work), OR (b) expand Step 4's codemod scope to include `resilience.ts`, `packages/preset/src/index.ts`, `packages/core/src/index.ts`, `packages/core/src/orchestration/__tests__/*`, examples, and rewrite the `vi.spyOn(AgentLoop.prototype, 'dispose')` assertions to use a public `dispose` spy on the factory-returned object. Open Question #4 must be answered "keep value export for now" unless (b) is accepted with a time budget. The current ADR wording is under-scoped and blocks the test gate.

### 2. [HIGH] `IterationContext` mutable-box pattern is a regression, not parity, and the defence misstates the baseline

**Claim**: §2.3 introduces `IterationContext` with four mutable fields (`cumulativeStreamBytes: {value}`, `iterationSpanId`, plus `toolCallCounter: {value}` and `cumulativeUsage` on the config), defended in Appendix as "matches today's inline pattern, avoids allocation per iteration, and is contained". Today's baseline is *closure-scoped `let` locals* within `run()` (`agent-loop.ts:500,502`), not mutable fields on a shared object. The ADR's "allocation" argument is wrong: a plain-object box allocates more than a `let`. The real reason is cross-module state sharing — which is precisely the anti-pattern Wave-5B is supposed to eliminate (M-4: "implicit side-channel via instance field").

**Evidence**:
- Today: `run()` L500 `let iterationSpanId: string | undefined;`, L502 `let cumulativeStreamBytes = 0;`. Assigned and read inside the same closure. No boxes.
- Today: `private cumulativeUsage` (L259) and `this._totalToolCalls` (L264) ARE instance fields — but `runIteration` being handed `cumulativeUsage: {inputTokens, outputTokens}` and `toolCallCounter: {value}` via `IterationRunnerConfig` replicates the exact shared-mutable-state shape the ADR says it is removing (M-4).
- R8 (LOW) acknowledges the re-entrancy risk but dismisses it as "AgentLoop.run()'s re-entrancy guard is the enforcement point". That guard (L442–L448) prevents overlapping `run()` calls on the same `AgentLoop`, but the ADR explicitly notes "the runner is reusable across iterations **and across runs**" (§2.3). Across runs the runner's config-level mutable `cumulativeUsage` / `toolCallCounter` must be reset each run — where? The ADR does not say. A second `run()` reusing the same `iterationRunner` would observe leftover state from the previous run.

**Required change**:
- Either remove the "reusable across runs" claim in §2.3 and make `createIterationRunner` per-run (called from inside `run()`), OR
- Make `IterationContext` the carrier of **all** per-run state (including the four fields currently on `IterationRunnerConfig` — `cumulativeUsage`, `toolCallCounter`, plus the new `cumulativeStreamBytes` and `iterationSpanId`), and construct a fresh context at each `run()` call.
- Add an explicit invariant: "IterationRunner holds no per-run state on its closure; all mutable state lives on `IterationContext`, which is freshly allocated per `run()`." Then the "no concurrency guarantees" framing in the ADR becomes honest.
- Drop the "avoids allocation" argument from the Appendix; it is counterfactual.

### 3. [HIGH] `onRetry` callback cannot replicate today's `adapter_retry` span enrichment verbatim on the chat path

**Claim**: §2.1 defines `onRetry?: (info: { attempt: number; errorCategory: string; path: 'chat' | 'stream' }) => void`. But the actual span enrichment (see `agent-loop.ts:693–702`) on the chat path writes THREE attributes: `attempt`, `errorCategory`, **and** `error: (err instanceof Error ? err.message : String(err)).slice(0, 500)`. The stream path (L648–L651) writes only two. The callback surface loses `error` on the chat path — no test in `span-enrichment.test.ts` currently asserts the `error` attribute presence (verified: the suite only checks `attempt`), so the regression would slip through the ADR's "tests stay green" gate *and* silently drop observability data that `docs/architecture/01-core.md:161` advertises ("错误消息预览前 500 字符").

**Evidence**:
- `agent-loop.ts:694–701`: `name:'adapter_retry', attributes: {attempt, errorCategory, error: ...slice(0,500), path:'chat'}`.
- `agent-loop.ts:649–650`: `attributes: {attempt, errorCategory, path:'stream'}` — no `error`.
- ADR §2.1 `onRetry` shape: `{attempt, errorCategory, path}` — drops `error`.
- `docs/architecture/01-core.md:161` documents this as a public observability contract.
- `packages/core/src/core/__tests__/span-enrichment.test.ts:114–117` only asserts `attempt` exists; the missing-test gap is what lets this regression land silently.

**Required change**:
- Extend `onRetry` shape to `{ attempt; errorCategory; path; errorPreview?: string }` (chat-only populated; stream path passes `undefined`). Document the asymmetry explicitly.
- Add a Step 2 test: assert `adapter_retry` span event on the chat path carries an `error` attribute ≤500 chars. This is non-optional — otherwise the claim "span-enrichment.test.ts stays green" is trivially true but misses a contract regression.

### 4. [HIGH] Step 1's half-hybrid state does expose chat+stream on the same instance; "tests stay green at every step" needs a concrete walk-through or a rescoped Step 1

**Claim**: §7 Step 1 says "Streaming branch (L632–L674) still uses `this.handleStream` + `_lastStreamErrorCategory` — deferred to Step 2" while Step 1 introduces `adapterCaller.call(...)` for the chat branch. The ADR claims all 3780+ tests remain green after Step 1. But a single `AgentLoop` instance after Step 1 owns BOTH `this.adapterCaller` (with its own signal, its own retry policy, its own onRetry) AND the inline `this.handleStream` + `this._lastStreamErrorCategory`. The instance is a consistency hazard: if the `streaming` flag flips per-iteration (it does not today, but `this.streaming && this.adapter.stream` is re-evaluated at L632 every attempt), or a test toggles stream vs. chat by providing both adapter methods, the two paths now diverge on retry accounting.

**Evidence**:
- `agent-loop.ts:632` `if (this.streaming && this.adapter.stream)` is re-evaluated per attempt. Adapters with *both* `chat` and `stream` defined and `streaming:true` use the stream branch. If Step 1's `AdapterCaller` is only constructed with `streaming:false` semantics (per Rationale), but some tests pass `streaming:undefined` or default-false and an adapter that still has a `stream` method, the non-streaming call site now routes through `AdapterCaller` while a sibling test case on the same `AgentLoop` class uses `handleStream`. The retry `attempt` counter is now split: one in `AdapterCaller` closure, one in the outer `run()` `for (let attempt...)` loop that still encloses the stream branch.
- Unclear from the ADR: does Step 1 delete the `for (let attempt...)` outer loop, or keep it with an internal break when the chat branch is delegated? If kept, retry semantics for mixed adapter tests change. If deleted, Step 1 can't leave the streaming branch untouched (because the streaming branch lives inside that same for-loop today — L622).

**Required change**:
- §7 Step 1 must state explicitly what happens to the `for (let attempt = 0; attempt <= maxAdapterRetries; attempt++)` loop at `agent-loop.ts:622`. Option A: keep the loop, delegate only the `adapter.chat` call (single attempt) to a thin `AdapterCaller.callOnce`, move retry ownership to Step 2/3. Option B: delete the loop for the chat path only, and accept that streaming still has its own retry loop until Step 2 — at which point document that the intermediate state has two retry implementations coexisting. Either way, pick one, and spell out which of the ~30 non-streaming tests exercises retry.
- Add a concrete test walkthrough: pick "retries on rate-limit then succeeds" (chat) and "retries on rate-limit then succeeds" (stream) and show which code path fires at each of Step 1, Step 2, Step 3 boundaries.

### 5. [MEDIUM] `bailOut` with 5 optional fields is complexity relocated, not complexity eliminated; tagged variants would catch a real bug class

**Claim**: §4's `BailOutInput` has `reason`, `errorEvent?`, `guardrailEvent?`, `abort?`, `messageEvent?`, `spanStatus?` — five optionals with implicit ordering constraints ("messageEvent BEFORE guardrailEvent BEFORE errorEvent" enforced only by `bailOut`'s body). The mapping table in §4 shows 11 call-sites collapsing to one shape, but the 11 actually fall into only **4 distinct shapes**:
- `(reason='error'|..., errorEvent, maybe abort)` — the error+optional-abort pattern (5 sites)
- `(reason='error', abort:true, guardrailEvent, errorEvent)` — guardrail-block (2 sites)
- `(reason='token_budget', messageEvent, errorEvent)` — post-call budget (1 site)
- `(reason='end_turn', messageEvent, spanStatus:'completed')` — happy path (1 site)

A tagged variant (`BailOutInput = ErrorBail | GuardrailBail | BudgetBail | EndTurnBail`) with per-variant required fields would make illegal states unrepresentable and let the compiler flag a bail-out that omits `abort:true` on a guardrail block (a real today-bug shape: L595 abort; L596 yield; if a future contributor adds a new guardrail path and forgets `abortController.abort()`, the type system is silent under the optional-bag approach).

**Evidence**:
- §4 table rows collapse into the four shapes above. The optional-bag approach accepts e.g. `{reason:'end_turn', errorEvent: foo}` as type-valid, which is nonsensical.
- Today's duplication bug pattern (M-4 finding) is exactly "some branch forgot `abortController.abort()`" — a tagged variant prevents it; the optional bag does not.

**Required change**:
- Recast `BailOutInput` as a discriminated union keyed on `reason` with per-variant required fields. The implementation becomes a `switch` on `input.reason` instead of a chain of `if (input.xxx)` yields. ~20 extra LOC of type definition; zero runtime cost; eliminates a real class of future bugs.
- OR justify the optional-bag shape by exhibiting a future bail variant that cannot be expressed as a discriminated union. The current ADR shows no such example.

---

## Lower-priority concerns

- **§2.1 `AdapterCaller` always-generator API** (Appendix defence): accepted in principle, but the chat path will emit zero yields while a consumer awaits via `yield*`. Node's async-generator delegation adds ~2 microtask ticks per empty-yielding call; at the per-iteration granularity this is noise, but the ADR's phrasing "costing one extra async iterator tick — negligible" is imprecise. Reword or benchmark in Step 3.

- **§2.2 `maxCumulativeStreamBytes` derivation moves into AdapterCaller constructor**: today it is computed in `run()` L503 as `this.maxIterations * this.maxStreamBytes`. §7 Step 2 says "pass `maxCumulativeStreamBytes: maxIterations * maxStreamBytes`" — but `StreamHandlerConfig` takes it as an injected constant. If `maxIterations` is conceptually a run-level knob and `maxStreamBytes` a per-stream knob, putting their product on `StreamHandlerConfig` fixes it at construction and prevents future per-run overrides. Flag this as an explicit design decision in §2.2, or thread it through `IterationContext` as a derived constant.

- **R1 asymmetry: chat yields error, stream does not (re-yield)**: the ADR notes this and mitigates via JSDoc, but the critic's question ("should ALL error events be yielded by AdapterCaller for symmetry?") stands. The asymmetry *is* defensible (the underlying reason is that StreamHandler is a sub-generator doing its own `yield* aggregator.handleChunk`, while chat is a single `await`), but the ADR should own the asymmetry by exposing an explicit `yieldErrorEvent: boolean` in the internal contract rather than relying on the caller to remember. Step 2 must include a test: "exactly one `{type:'error'}` event observed per failed stream across all retries" — today this is implicit, after decomposition it becomes a regression risk because TWO yield points exist.

- **§2.3 `buildDoneEvent` callback**: correctly flagged by the critic as a leaky abstraction. The ADR defence ("`_status` mutation stays with AgentLoop") is weak — the only thing the callback does today (L1200–L1203) is mutate `_status` and return a `{type:'done', ...}` object with `totalUsage: this.usage`. IterationRunner already has access to cumulativeUsage via config. The cleaner shape is: IterationRunner builds the done event's payload (reason + totalUsage), AgentLoop's `run()` handles `_status` transition on the event pass-through. Remove the callback; return `{kind:'terminated', reason, totalUsage}` from `IterationOutcome` and let `run()` assemble the event. This also removes one of the five concerns critics can raise about Open Question #3.

- **R3 hook firing order** adequately specified, but R3 does not cover the `fireIterationEnd` ownership transfer. Today `fireIterationEnd` is a closure captured by every early return. After the split, IterationRunner owns it; ADR §2.3 implies this via "fireIterationEnd(ctx.iteration, true)" in §4's bailOut. Make this explicit: `IterationContext` must carry `iterationEndFired: {value: boolean}` or IterationRunner must own a per-iteration closure local — the current text is ambiguous.

- **R5 iterationSpanId double-close**: mitigation relies on nulling `ctx.iterationSpanId` after endSpan. Good. But `run()`'s outer finally (L1019) still calls endSpan on iterationSpanId — after decomposition that variable lives on `IterationContext`, not on `run()`'s scope. The ADR must specify that `run()` reads `ctx.iterationSpanId` in the finally (turning `ctx` into a run-level durable).

- **Open Question #1 `categorizeAdapterError` static**: delete is correct under 1.0-rc, but the ADR misses that the static is also `@deprecated`-comment-referenced elsewhere (grep finds no external callers per b4). Confirm nothing imports `AgentLoop.categorizeAdapterError` statically; the public `categorizeAdapterError` from `error-classifier.js` is already exported (`core/index.ts:85`). Safe.

- **No explicit mention of `this._totalToolCalls` migration**: L937 increments `this._totalToolCalls++` inside the tool-result loop. §2.3 IterationRunnerConfig has `toolCallCounter: {value: number}` which appears to replace it. But `getMetrics()` (L413) still reads `this._totalToolCalls` — AgentLoop must now read from the mutable box. Trivial but missing from §7.

- **No discussion of `this._iteration` mutation** (L263, L518). After decomposition, who writes it? IterationContext has `iteration` readonly. The outer `run()` loop must still maintain `this._iteration` for `getMetrics`. Worth one line in §7 Step 3.

- **Migration Step 3 claim "semantic no-op"** for guardrail inlining is checkable but unverified. `agent-loop-guardrails.test.ts` asserts exact event sequences, and `pickBlockingGuardName` moving from `AgentLoop` static to `guardrail-helpers.ts` is mechanical. But `findLatestUserMessage` has subtle behaviour (walks from tail, skips non-user) — confirm no other caller relies on the `AgentLoop` static form; grep shows zero external callers. Safe.

- **`strategyOptions` Readonly tightening (M-5)**: ADR correctly proposes this in Step 3. But `execution-strategies.ts` parallel implementation reads `options.signal.aborted` — no mutation. Confirmed. The tightening is safe. Note in §7 Step 3 that a snapshot-of-typecheck-clean after the change is the gate.

---

## Things the ADR got right

- **Three-module cut rationale** (§2 intro) is actually argued, not asserted. The 2-module and 4-module rejections are both principled (M-4 isolation + backoff-as-helper-not-module).
- **`StreamResult` discriminated union** (§5) is exactly the right shape — `null + side-channel` → `{ok:false, errorCategory}` eliminates the side-channel cleanly. Keep.
- **Wave-5A preservation table** (§6) is the kind of explicit-mapping artifact that prevents regression; leave it as-is.
- **Migration incrementality** (§7) is the right structure even if Step 1's concrete plan needs tightening (see concern #4).
- **Appendix defences** address predictable critic points directly — good practice, keep doing this.
- **Risks §9** has real numbered failure modes with mitigations; R1 (yield-order asymmetry) and R2 (abort during backoff → ABORTED category) are the two that matter most and both are called out.
- **§4 call-site table** (11 terminal branches → bailOut mapping) is the most valuable artifact in the ADR; it is what makes `issue-fixer` able to execute Step 3 without re-deriving.

---

## Concrete required edits before lock-in

1. **§7 Step 4**: Rewrite the Step 4 block entirely. Replace "factory-only public surface" with either (a) "keep `AgentLoop` as runtime export, defer public-API hide to Wave-5C" (preferred — Wave-5C is explicitly "Package boundaries & API 1.0-rc" per `decisions.md`), OR (b) list every value-use site that must be rewritten: `packages/core/src/core/resilience.ts:13,89`; `packages/core/src/core/__tests__/resilience.test.ts:522,557,582`; `packages/core/src/orchestration/agent-pool.ts:7`; `packages/core/src/orchestration/__tests__/agent-pool.test.ts:2,8`; `packages/core/src/orchestration/__tests__/integration.test.ts:5`; `packages/core/src/index.ts:15`; `packages/preset/src/index.ts:10,414`; `examples/**/*.ts`. Answer Open Question #4 accordingly.

2. **§2.3 + Appendix**: Strike the "avoids allocation per iteration" defence for `IterationContext`; it is counterfactual relative to today's `let` locals. Replace with a statement that `IterationContext` is freshly allocated per `run()` call and owns ALL per-run mutable state (move `cumulativeUsage`, `toolCallCounter`, `iterationSpanId`, `cumulativeStreamBytes`, and `iterationEndFired` onto `IterationContext`). Remove these fields from `IterationRunnerConfig`. Re-answer Open Question #3 with this shape.

3. **§2.1 `onRetry`**: Extend shape to `{ attempt; errorCategory; path; errorPreview?: string }`. Document that chat path MUST populate `errorPreview` with `(err instanceof Error ? err.message : String(err)).slice(0, 500)` and stream path MAY omit. Add a Step 2 gating test: `adapter_retry` event carries `error` attribute ≤500 chars on chat failure.

4. **§7 Step 1**: Replace "Streaming branch still uses `this.handleStream`" with a paragraph that explicitly states: (a) whether the outer `for (let attempt...)` loop at L622 is kept or deleted in Step 1, (b) which tests exercise the chat retry path (name them) and which exercise the stream retry path, (c) what the hybrid instance looks like structurally. Add one concrete walkthrough: "test X follows path A through the Step 1 intermediate state". Without this, "tests stay green" is a claim, not a guarantee.

5. **§4 `BailOutInput`**: Recast as a discriminated union on `reason` with per-variant required fields. Provide the updated type block. Update the implementation sketch to a `switch`. This is the only change that materially reduces *future* bug surface; the optional-bag shape is net-neutral.

6. **§2.3 remove `buildDoneEvent` callback**: Change `IterationOutcome` to `{ kind:'terminated'; reason: DoneReason; totalUsage: TokenUsage }` and let `run()` synthesise the done event. Drop the callback from `IterationRunnerConfig`. Mention this in §7 Step 3 as a specific structural edit.

7. **Add to §9 Risks**: R9 (new) · "cross-run state leak via IterationRunner reuse" — mitigation: "construct IterationRunner inside `run()`, not in the constructor". If the ADR keeps the reusable runner claim, this risk must be explicitly addressed.

8. **Update §7 Step 3** to explicitly list `this._totalToolCalls` and `this._iteration` as fields that remain on AgentLoop (for `getMetrics()`) and whose write-paths move from `run()` to "orchestrator reads from IterationContext after each runIteration and forwards".

Once edits 1–6 are in, the proposal clears the critic gate.

---

## 200-word summary

**Verdict: ACCEPT-WITH-CHANGES.** The three-module decomposition (AdapterCaller / StreamHandler / IterationRunner) is the right cut: it cleanly eliminates the `_lastStreamErrorCategory` side-channel via a discriminated `StreamResult`, and §4's 11-site bailOut mapping is the artifact that makes Step 3 executable. However, four issues block lock-in. **First**, Step 4's factory-only public surface is infeasible as written — `packages/core/src/core/resilience.ts:89` does `new AgentLoop(loopConfig)` in shipped code and `resilience.test.ts` calls `vi.spyOn(AgentLoop.prototype, 'dispose')`; a type-only re-export breaks both. Either keep the value export or dramatically expand the codemod scope. **Second**, the `IterationContext` mutable-box pattern plus mutable fields on `IterationRunnerConfig` (`cumulativeUsage`, `toolCallCounter`) reintroduce cross-run shared-mutable-state after the ADR promises to remove it; the "avoids allocation" defence is counterfactual versus today's `let` locals. **Third**, `onRetry: {attempt, errorCategory, path}` drops the `error` attribute that today's chat-path `adapter_retry` span event carries (`agent-loop.ts:698`) and is a documented observability contract. **Fourth**, Step 1's "tests stay green" claim needs a concrete walkthrough of the hybrid chat-via-caller / stream-via-handleStream instance. Fix these and the design ships.
