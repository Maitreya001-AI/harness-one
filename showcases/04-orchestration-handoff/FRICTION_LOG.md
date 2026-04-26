# FRICTION_LOG · 04-orchestration-handoff

> Per `docs/harness-one-showcase-method.md` Stage 3 rule 2: every time
> we work around / get stuck on harness-one, append a timestamped entry
> immediately.

---

## 2026-04-26 — `spawnSubAgent` swallows adapter / loop errors silently

**Friction**: This is the highest-severity finding from the showcase
build. When the adapter throws (e.g. `createFailingAdapter` returning
its rejection), `spawnSubAgent`:

1. Lets `AgentLoop` catch the throw internally.
2. AgentLoop emits an `error` event and then a `done` event with
   `reason: 'error'`.
3. spawnSubAgent's iteration loop only inspects `message`, `tool_result`,
   and `done` events — the `error` event is dropped silently.
4. spawnSubAgent records `doneReason: 'error'` and **returns
   normally** with `usage` and the partial `messages`.

Net effect: a caller that wraps `spawnSubAgent` in `try / catch`
expecting "if it fails it throws" is fooled — they get a clean Promise
resolution and never see the failure unless they explicitly inspect
`doneReason`. The showcase's first run had `errorThrown=false` because
of this; we had to wrap `spawnSubAgent` in our own helper that
inspects `doneReason` and re-throws.

**Workaround**: helper around `spawnSubAgent` that throws on
`doneReason === 'error'` (and `'aborted'`, for the same reason):

```ts
const result = await spawnSubAgent(opts);
if (result.doneReason === 'error') {
  throw new HarnessError(
    `agent "${name}" failed`,
    HarnessErrorCode.ADAPTER_ERROR,
    'check the parent agent\'s adapter or downstream agents for the originating error',
  );
}
if (result.doneReason === 'aborted') {
  throw new HarnessError(...);
}
```

**Feedback action**:
- [x] **Resolved** in `packages/core/src/orchestration/spawn.ts`:
      `spawnSubAgent` now throws `HarnessError(ADAPTER_ERROR)` with the
      originating exception as `cause` when `doneReason === 'error'`,
      and `HarnessError(CORE_ABORTED)` when `doneReason === 'aborted'`.
      Soft-budget reasons (`max_iterations`, `token_budget`,
      `duration_budget`, `guardrail_blocked`) still resolve normally so
      callers can inspect partial work.
- [x] JSDoc updated with a full table mapping every `doneReason` to the
      resolve/throw behaviour.
- [x] Tests in `packages/core/src/orchestration/__tests__/spawn.test.ts`
      cover the new throw contract: pre-aborted signal, mid-flight abort,
      adapter rejection with cause-chain preservation, multiple-error
      ordering, message+suggestion grep-ability.

**Severity**: high — this is the most expensive kind of bug to debug.
The error is NOT in the harness (it correctly captures and tags the
failure), it's in the API ergonomics. Real users wiring multi-agent
pipelines will assume Promise rejection on failure and write code that
never sees the error.

**Suspected root cause**: spawnSubAgent was likely modeled on
`AgentLoop.run()` which is a generator (errors can land as events).
But `spawnSubAgent` returns a Promise, and Promise semantics in JS
make rejection the natural failure channel. The mismatch happened at
the API translation layer.

---

## 2026-04-26 — `HarnessErrorCode` namespace prefix is inconsistent (`CORE_*` vs bare names)

**Friction**: Wrote `HarnessErrorCode.CORE_ADAPTER_ERROR` based on
naming convention for other codes (`CORE_INVALID_CONFIG`, `CORE_ABORTED`,
etc.). Real symbol is `ADAPTER_ERROR` (no `CORE_` prefix).
TS2551 with a "Did you mean ..." suggestion saved the day.

**Workaround**: Use `ADAPTER_ERROR` as written.

**Feedback action**:
- [ ] Convention: pick one prefixing scheme and apply uniformly.
      Currently the codebase has `CORE_INVALID_CONFIG`, `CORE_ABORTED`,
      `STORE_CORRUPTION`, `ADAPTER_ERROR`, etc. — the prefix varies by
      "where in the code does this come from" rather than any
      consistent rule, so callers can't predict the right name without
      autocomplete.

**Severity**: low — autocomplete catches it; the mistake costs ~5
seconds per occurrence.

---

## 2026-04-26 — Cascade abort scenario didn't trigger because mock chain runs faster than abort scheduling

**Friction**: Scenario 3 (cascade abort) scheduled `ctrl.abort()`
1ms after start. With mock adapters the entire 4-agent chain
completes in <1ms, so the abort never landed during in-flight work.
The scenario reports `aborted=false latencyMs=0` consistently.

This isn't a harness-one bug — it's a showcase design issue. To
actually exercise cascade abort we need either (a) slow adapters (with
artificial setTimeout in `chat()`), or (b) real adapters with network
latency.

**Workaround**: For MVP, accept the scenario as "no exception
escapes", document the limitation. A follow-up enhancement: introduce
a slow mock adapter helper.

**Feedback action**:
- [x] **Resolved 2026-04-26** — `harness-one/testing` now exports
      `createSlowMockAdapter({ chatDelayMs, streamChunkDelayMs,
      respectAbort })`. Delays are interruptible via the
      AbortSignal so cascade-abort tests are deterministic without
      real network. Tests in
      `packages/core/src/testing/__tests__/extra-helpers.test.ts`
      cover signal-honouring, signal-ignoring, and inter-chunk delay.

**Severity**: low — limits what this showcase can prove, but doesn't
indicate a harness defect.

---

## (Append new entries above this line — newest first.)
