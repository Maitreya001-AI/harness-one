# FRICTION_LOG · 01-streaming-cli

> Per `docs/harness-one-showcase-method.md` Stage 3 rule 2: every time we
> work around / get stuck on harness-one, append a timestamped entry
> immediately. This file is the primary input to the Harvest stage and
> the reason the showcase produces feedback for the main repo.

---

## 2026-04-26 — `ModelPricing` field name disagrees with PLAN doc and shared mental model

**Friction**: PLAN-stage assumption (and the natural English reading of
"per-1k cost") was `inputCostPer1k` / `outputCostPer1k`. Real type
fields are `inputPer1kTokens` / `outputPer1kTokens` (defined at
`packages/core/src/core/pricing.ts:18`). Compile-time error TS2353.

**Workaround**: Use real field names in showcase code.

**Feedback action**:
- [ ] Issue: rename or add `inputCostPer1k` alias for ergonomic
      consistency with conversational naming.
- [ ] Doc: ModelPricing JSDoc currently says
      "dollar-per-1k-token values"; renaming the field to make this
      clearer at the call site is worth a tiny RFC.

**Severity**: low

**Suspected root cause**: Field name was generated bottom-up from the
internal calc (`tokens / 1000 * rate`), not top-down from the user's
mental model.

---

## 2026-04-26 — `HarnessLifecycle` lacks the documented `transitionTo(state)` API

**Friction**: Naïve usage tried `lifecycle.transitionTo('ready')`, mirroring
the state-machine vocabulary in PLAN.md. The actual interface (at
`packages/core/src/observe/lifecycle.ts:53`) has four named transition
methods: `markReady()`, `beginDrain()`, `completeShutdown()`,
`forceShutdown()` (plus `markReadyAfterHealthCheck()` and `dispose()`).

**Workaround**: Use the named methods.

**Feedback action**:
- [ ] Doc: PLAN.md (and the showcase method doc that lifts language from
      it) talks about transitions in terms of "state X → Y" but the API
      uses imperative verbs. Add a row to the lifecycle docs mapping
      "from state Y to state X = method M()" so this is grep-able.

**Severity**: low

**Suspected root cause**: The named-verbs API is the right design (it
prevents illegal transitions at the type level), but the discoverability
gap means new callers reach for `transitionTo(state)` first. A short
paragraph in lifecycle.ts top-of-file docstring would close it.

---

## 2026-04-26 — `TraceManager.shutdown()` doesn't exist; the right method is `flush()`

**Friction**: Habit from other observability libs (OpenTelemetry's
`shutdown()` flushes + closes exporters). harness-one's `TraceManager`
exposes `flush()` and the host owns lifecycle. TS2339 at compile.

**Workaround**: Call `traces.flush()` in the shutdown handler.

**Feedback action**:
- [ ] Doc: A short `// Want shutdown? Use flush() — TraceManager itself
      has no lifecycle.` comment at the top of `trace-manager.ts` would
      pre-empt this exact mistake every time someone migrates from OTel.

**Severity**: low

**Suspected root cause**: Familiar-but-different API surface vs.
neighboring tools.

---

## 2026-04-26 — `AgentLoopConfig` abort field is `signal`, not `externalSignal`

**Friction**: I wrote `externalSignal: ctrl.signal` based on PLAN
language ("the external abort signal"). The real field is just
`signal` (`packages/core/src/core/agent-loop-types.ts:117`).

**Workaround**: Use `signal:` field name.

**Feedback action**: None — this one is a my-mistake, not a harness
problem. PLAN's "external" language was descriptive prose, not API.

**Severity**: trivial

---

## 2026-04-26 — `onText` AgentLoopConfig hook lacks parameter type when used directly

**Friction**: Passed `onText: (text) => { void text; }` in
`AgentLoopConfig`. TypeScript flagged `text` as implicit `any` (TS7006)
because the inline arrow was wider than the declared hook type.

**Workaround**: Either drop the unused hook (we already consume
`text_delta` events from the run() iterator) or annotate the param
explicitly. We removed the hook — it was redundant for the showcase.

**Feedback action**:
- [ ] Minor: a clearer JSDoc example for `onText` that shows the
      signature would let editor inference flow without the explicit
      annotation.

**Severity**: trivial

**Suspected root cause**: A hook field that's optional + has multiple
overloaded arities is harder for inference to walk than a single
required signature. Not blocking.

---

## 2026-04-26 — `createStreamingMockAdapter` doesn't auto-attach usage to `done`

**Friction**: First-pass showcase code emitted text_delta chunks plus a
bare `{ type: 'done' }` chunk (no `usage`). The result: AgentLoop
cumulative usage stayed at 0 in streaming mode, the cost report showed
$0, and there was nothing to assert against.

The helper takes a top-level `usage` config field that the *non-streaming*
`chat()` path uses for the response, but the `stream()` path emits
exactly the chunks the caller passed — no auto-injection of usage into
the terminal done. This is internally consistent (the helper does what
its name says) but the failure mode is silent (no warning, no error,
just zeroed metrics).

**Workaround**: Append `{ type: 'done', usage: {...} }` chunks
explicitly in the scripted reply builder.

**Feedback action**:
- [ ] Issue: when `createStreamingMockAdapter` chunks contain no `usage`
      on the terminal `done`, either (a) auto-fill from `config.usage`,
      or (b) emit a warning. Silent zero metrics in tests is a footgun
      because cost-related assertions look superficially fine.
- [ ] Doc: the helper docstring shows a chunks example without usage —
      add a one-line note that production providers attach usage to done
      and tests should mirror that.

**Severity**: medium — the failure mode is silent. Anyone wiring the mock
into a cost assertion will get a false negative they may not chase down.

**Suspected root cause**: The mock helper was authored against the
agent-loop test fixtures (which set usage at the `chat()` level for
non-streaming tests). Streaming tests in the harness suite supply usage
manually so this gap was never felt by maintainers.

---

## (Append new entries above this line — newest first.)
