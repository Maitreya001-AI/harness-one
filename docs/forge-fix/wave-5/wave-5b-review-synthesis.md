# Wave-5B Review Synthesis

**Date**: 2026-04-15
**Reviewers**: code-reviewer #1, code-reviewer #2, red-team-attacker
**Scope**: Wave-5B AgentLoop decomposition (B1–B4 on `wave-5/production-grade`)
**Synthesizer**: review-synthesizer

---

## Verdict: **APPROVE-WITH-FOLLOW-UPS**

**Confidence**: High

No CRITICAL / HIGH correctness defects. One confirmed MEDIUM regression vs pre-Wave-5B (adapter-stream iterator leak on external `.return()`) plus one MUST-FIX doc-sync obligation from the repo's memory rule. Everything else is polish that can land alongside or after the B6 doc-updater.

**Totals after de-dup**:
- Must-fix-before-merge: **3** (1 regression, 1 doc rule, 1 correctness narrowing)
- Should-fix-this-wave: **4** (dead surface, missing error context, migration comments, stale comment)
- Defer to Wave-5C / backlog: **6**
- Confirmed-cleared: **9** attack surfaces

**Cross-validation highlights**:
- RT-1 (stream-close regression) found by red-team only; both code reviewers missed it — real, one-line fix.
- N-3 ≡ CQ-005 (stale `safeStringifyToolResult` comment) — independent confirmation, counted once.
- CQ-001 re-entrancy-post-`completed` is arbitrated **NOT a Wave-5B regression** (see §6).

---

## 1. Must-Fix-Before-Merge

### MF-1. Wrap AdapterCaller's manual pump in `try/finally` to forward iterator close — **CONFIRMED REGRESSION**

- **Source**: red-team `RT-1` (M-1 in `wave-5b-review-redteam.md`)
- **Location**: `packages/core/src/core/adapter-caller.ts:263-318`
- **Rationale**: Pre-Wave-5B used `yield*` through `handleStream`, so consumer `.return()` on `run()` propagated via JS iterator-close protocol and triggered `finally` blocks in the adapter's `stream()` generator. Wave-5B's manual `while(true) { await streamGen.next() }` pump breaks this chain. Adapters that don't cooperate promptly with `config.signal` (slow HTTP/2, test doubles) will leak file handles / sockets / timers between consumer-break and `finalizeRun`-driven abort. This is the single behavioural regression vs pre-Wave-5B and the one the B0 brief explicitly asked reviewers to watch for.
- **Fix** (one line):
  ```ts
  const streamGen = config.streamHandler.handle(conversation, cumulativeStreamBytesSoFar);
  try {
    while (true) { /* existing pump */ }
  } finally {
    await streamGen.return(undefined).catch(() => { /* already done */ });
  }
  ```
- **Verification**: add the vitest sketch from the red-team report as a regression test.

### MF-2. Update `docs/architecture/01-core.md` to reflect Wave-5B decomposition — **REPO MEMORY RULE**

- **Source**: code-reviewer #1 `N-8`
- **Location**: `docs/architecture/01-core.md:16`
- **Rationale**: The `feedback_update_arch_docs.md` memory rule mandates arch-doc updates on architecture-relevant code changes. `agent-loop.ts` was 440 LOC in that doc; it is now 845 LOC plus three new sibling modules (`adapter-caller.ts`, `stream-handler.ts`, `iteration-runner.ts`). Shipping Wave-5B without this update is a policy violation. The B6 doc-updater step is the natural home; block merge on its completion OR inline the update into this wave.

### MF-3. Narrow `ErrorBail.reason` union to `'error' | 'aborted'`

- **Source**: code-reviewer #2 `CQ-003`
- **Location**: `packages/core/src/core/iteration-runner.ts:121-129`
- **Rationale**: ADR-v2 §4 explicitly maps `L519-L526 (max_iterations)` to the orchestrator's `emitTerminal` path, NOT to `IterationRunner.bailOut`. No code path in `iteration-runner.ts` can legally construct `ErrorBail{reason:'max_iterations'}`. Keeping the member in the union is the exact bug-shape the discriminated-union recast was meant to preclude (per ADR §2.3 critic §2). It's a one-identifier removal with compile-time safety upside and zero behaviour change.

---

## 2. Should-Fix-This-Wave (before the B6 doc-updater lands)

Ordered by return-on-effort.

### SF-1. Delete vestigial `AdapterCaller.callOnce` public surface

- **Source**: code-reviewer #2 `CQ-004`
- **Location**: `adapter-caller.ts:30-45, 138-145, 199-217`
- **Rationale**: `callOnce` + `AdapterCallOnceOk/Fail/Result` are a B1 migration artifact; nothing outside AdapterCaller calls them. Publishing dead types on a 1.0-rc widens the public surface for no reason. Inline into `call()`; delete three types and the method.

### SF-2. Plumb `errorPreview` through stream-path `onRetry`

- **Source**: code-reviewer #2 `CQ-002`
- **Location**: `adapter-caller.ts:289`
- **Rationale**: `streamResult.error.message` is trivially available at the call site. ADR-v2 §2.1 documents the preview field as "UNDEFINED on the stream path" only because *today* (pre-Wave-5B) span attributes differ between paths — but once we're threading a callback anyway, there's no cost to parity. Operators triaging repeat stream failures currently get `errorCategory` only; giving them `error.message.slice(0, 500)` matches the chat-path observability.

### SF-3. Remove "Wave-5B Step N:" migration-history comments from runtime modules

- **Source**: code-reviewer #1 `N-6, N-7`
- **Locations**: `agent-loop.ts:351,364,379,385,485,564,646,668,719,772,820`; module headers in `adapter-caller.ts:1-22`, `iteration-runner.ts:1-21`, `stream-handler.ts:1-17`; `guardrail-helpers.ts:18,34`
- **Rationale**: Migration history belongs in ADR + commit messages, not in source that will outlive the migration. At 1.0-rc lock these become tomorrow's archaeology.

### SF-4. Fix stale `safeStringifyToolResult` comment

- **Source**: code-reviewer #1 `N-3` **≡** code-reviewer #2 `CQ-005` (de-duplicated — independent confirmation)
- **Location**: `iteration-runner.ts:167`
- **Rationale**: The comment claims the helper is "kept on AgentLoop as well" — it is not. Corrective one-line edit.

---

## 3. Defer to Wave-5C / Follow-Up Issues

Items that are out of 5B scope, pre-existing (not 5B regressions), or breaking changes:

| # | Item | Why defer | Source |
|---|------|-----------|--------|
| D-1 | `onIterationEnd` not fired on external close / mid-iteration throw | Pre-existing observability wart (also true pre-Wave-5B). File backlog issue; wrap `runIteration` in `try/finally { fireIterationEnd(ctx, false) }`. | red-team M-2 |
| D-2 | `dispose()` status override race (`'disposed'` → `'completed'`) | Pre-existing, cosmetic status-getter lie. Not new in 5B. | red-team M-3 |
| D-3 | `maxIterations * maxStreamBytes` overflow; retries bypass cumulative cap | Pre-existing; misconfiguration-only. Track for Wave-5C guardrail hardening. | red-team L-1, L-2 |
| D-4 | `assertNever` on `bailOut` switch + drop `default` arm | Defensive polish; no latent bug today because the union has 3 members all handled. Do at B6 or next refactor. | code-reviewer #1 N-1, N-2 |
| D-5 | `AdapterCallerConfig.streamHandler` required even when `streaming=false` | Minor allocation; ADR-v2 §2.1 treats StreamHandler as always-injected for simplicity. Optional follow-up. | code-reviewer #1 N-9 |
| D-6 | Dead `AdapterCallerConfig.onRetry` at top-level (IterationRunner overrides per-call) | True observation — clean it up with SF-1 if scope allows, else defer. | code-reviewer #1 N-11 |
| D-7 | `DoneReason = 'guardrail_blocked'` breaking change | Explicitly Wave-5C territory per CQ-009. | code-reviewer #2 CQ-009 |
| D-8 | `NonNullable<>` cast on `stream-handler.ts:111`; defensive index on guardrail-helpers | LOW, stylistic. | code-reviewer #1 N-4; code-reviewer #2 CQ-010 |
| D-9 | Empty catches on `backoff()` | Intentional per ADR §2.1 (only `AbortedError` should propagate); could narrow to `if (!(err instanceof AbortedError)) throw err` for explicitness. Low priority. | code-reviewer #1 N-5 |
| D-10 | Re-entrancy guard message mentions state also on ctx | Cosmetic. | code-reviewer #1 N-10 |

---

## 4. Confirmed-Cleared (do not re-review)

Red-team ran dedicated attacks against these and proved them safe; no need to revisit in B6 or downstream waves:

1. Discriminated-union `BailOutInput` soundness — no bypass
2. `_lastStreamErrorCategory` side-channel fully eliminated
3. Wave-5A guardrail invariants preserved (input fail-closed, tool_output post-push, single terminal)
4. Double-`{type:'error'}` on retry→terminal — single-error invariant holds
5. `onRetry` stale-closure capture (B3 migration from `_currentIterationSpanId`)
6. Re-entrancy guard against parallel `run()` calls (JS single-threading atomicity)
7. Type-system bypasses: no `as unknown as X`, no `@ts-ignore`/`@ts-expect-error`
8. Manual pump's `done:true` boundary — no post-terminal `.next()`
9. `maxStreamBytes` / `maxToolArgBytes` boundary parity with pre-Wave-5B

---

## 5. Cross-Verification Matrix

| Finding | CR#1 | CR#2 | Red Team | Severity | Disposition |
|---------|:----:|:----:|:--------:|:--------:|:------------|
| RT-1 stream-close regression | — | — | HIGH-CONF | MEDIUM (must-fix) | **MF-1** |
| N-8 / arch-doc drift | YES | — | — | MUST (rule) | **MF-2** |
| CQ-003 `ErrorBail.reason` narrow | — | YES | — | MEDIUM | **MF-3** |
| CQ-004 dead `callOnce` surface | — | YES | — | MEDIUM | SF-1 |
| CQ-002 stream-path `errorPreview` | — | YES | — | MEDIUM | SF-2 |
| N-3 / CQ-005 stale helper comment | YES | YES | — | LOW | SF-4 (de-duplicated) |
| N-6/N-7 migration comments | YES | — | — | LOW | SF-3 |
| CQ-001 re-entrancy-post-`completed` | — | **DISPUTED** | CLEARED | — | **arbitrated → not 5B regression**, see §6 |
| onIterationEnd on external close | — | — | MED | pre-existing | D-1 |
| dispose() status race | — | — | MED | pre-existing | D-2 |

---

## 6. Reviewer Disagreements & Arbitration

### 6.1 CQ-001 — Re-entrancy guard only checks `'running'`, allows 2nd run after `'completed'`

**Reviewer claim (CR#2)**: After run-1 completes, a second `run()` passes the guard, reuses the single `abortController` (constructed once in `startRun` pre-Wave-5B or at L333 today; not reset), then `run()`-loop iteration-1 overwrites `this.cumulativeUsage` with freshly-zeroed `ctx.cumulativeUsage` at L542-L545, silently zeroing the first run's usage record. If run-1 ended aborted, run-2's first `isAborted()` check bails immediately.

**Evidence gathered** (git archaeology of commit `02d926d` — T10, the last pre-Wave-5B commit):

- Pre-Wave-5B: `private cumulativeUsage` was a class field initialised at construction (L259), **never reset per run**. A 2nd run would *additively* continue the first run's counters.
- Pre-Wave-5B: `abortController = new AbortController()` created once in constructor (L328 of T10), **also never reset**. If run-1 aborted, run-2's first `isAborted()` bailed the same way.
- Pre-Wave-5B: Re-entrancy guard at L442 checked **only** `_status === 'running'`, identical to today.
- Pre-Wave-5B comment at that guard: *"The supported pattern is 'one run per AgentLoop instance' or 'serialize calls'."* — documented one-shot-instance lifecycle.

**Arbitration**: **CQ-001 is NOT a Wave-5B regression.** The 2nd-run-after-completion path was already broken (state-bleed for `cumulativeUsage`; dead-on-arrival if run-1 aborted) in the T10 baseline. Wave-5B's change at L542-L545 flips *which direction* the state-bleed goes (pre: additively accumulates across runs; post: zeroes on 2nd-run iteration-1) — different symptom, same root cause. The docstring and guard comment both treat this as an unsupported path.

**However**, for a 1.0-rc quality bar, leaving the wart latent is a footgun. **Recommendation**: file a Wave-5C follow-up to either (a) explicitly throw `INVALID_STATE` when `_status === 'completed' | 'disposed'` (strict one-shot), or (b) fully reset run-scoped state (`abortController`, `cumulativeUsage`, `_totalToolCalls`, `_iteration`, `_noPipelineWarned`) at the top of `startRun()`. Option (a) aligns with the existing docstring and is lower-risk.

**Not blocking Wave-5B merge.** Track as `D-11: Formalise AgentLoop one-shot lifecycle` in the Wave-5C brief.

### 6.2 CQ-003 vs ADR §4

No disagreement between reviewers; arbitrated against the ADR directly. ADR-v2 §4 row for `L519-L526 (max_iterations)` says `max_iterations` stays in `run()` via `emitTerminal`, not `bailOut`. CQ-003 is aligned with the ADR; the current `ErrorBail.reason` union is wider than the ADR mandates. **CR#2 is correct → MF-3.**

### 6.3 De-duplication

N-3 (CR#1) and CQ-005 (CR#2) target the same comment at `iteration-runner.ts:167`. Counted once as SF-4. Independent discovery raises confidence but not severity.

---

## 7. Post-Fix Re-Review Scope

After MF-1 / MF-2 / MF-3 land:

- **Red-team re-test**: run the RT-1 repro vitest; confirm `streamReturnCalled === true`. Re-grep for any other manual pumps that might share the pattern.
- **Code-review re-check**: diff `ErrorBail` usage sites; confirm no caller constructs `'max_iterations'`. Read refreshed `docs/architecture/01-core.md` against the shipped module layout.
- **No spec re-review needed** — ADR §2/§3 unchanged by these fixes.

---

## 8. Review Quality Notes

**Coverage**:
- Spec compliance — covered via ADR-v2 cross-check in this synthesis (no dedicated spec-reviewer this wave; ADR-v2 absorbed the critic round)
- Code quality — 2 independent reviewers (CR#1, CR#2), diverse findings, only 1 overlap (good signal)
- Security — red-team ran 9 attack classes; cleared 9, found 3 MEDIUMs (1 regression, 2 pre-existing)

**Blind spots caught by cross-validation**:
- RT-1 (regression) missed by both code reviewers — iterator-protocol bugs are hard to spot statically. Argues for retaining dedicated adversarial review in future waves.

**Blind spots remaining** (flagged for operator awareness):
- No benchmark comparison of pre-Wave-5B vs post-Wave-5B streaming throughput. ADR-v2 §9 notes allocation parity but does not require a perf gate.
- No formal contract test for the `AgentEvent` sequence invariant across the orchestrator / IterationRunner / AdapterCaller / StreamHandler seam. Current coverage is integration-level only.

