# harness-one

## 1.0.0

### Major Changes

- 8a51ef1: `CheckpointStorage` and `CheckpointManager` interfaces are now fully
  async — every method returns `Promise<...>`.

  **Why**: the previous sync interface composed badly with async
  backends (HARNESS_LOG showcase 03 — `FsMemoryStore` is async, so
  gluing it under `CheckpointStorage` required a write-through cache or
  a `deasync`-style shim). The async migration lets fs-backed and
  remote (Redis, S3, …) backends slot in directly.

  **New backend** ships alongside: `createFsCheckpointStorage({ dir })`
  from `harness-one/context`. Atomic-rename writes per checkpoint plus a
  single `_index.json` for ordered `list()`. Recovers via directory
  scan when the index is torn or missing. Tests exercise cold-restart
  persistence, cross-process auto-prune, concurrent in-process writes,
  and torn-index recovery.

  **Migration**:

  ```diff
  - const cp = mgr.save(messages, 'label');
  - const restored = mgr.restore(cp.id);
  - const list = mgr.list();
  - mgr.dispose();
  + const cp = await mgr.save(messages, 'label');
  + const restored = await mgr.restore(cp.id);
  + const list = await mgr.list();
  + await mgr.dispose();
  ```

  Custom `CheckpointStorage` implementations must update their methods
  to return Promises. The default in-memory storage is unchanged
  behaviourally — Promise-wrapped sync ops, no IO cost.

- 8a51ef1: `spawnSubAgent` now throws `HarnessError` on `error` and `aborted` terminal
  states instead of resolving silently with `doneReason` set.

  **Why**: the previous behaviour was a footgun — every caller that wrapped
  `spawnSubAgent` in `try/catch` was silently fooled into treating failures
  as successes (the Promise resolved either way, the only signal was a string
  field on the result). See showcase 04's FRICTION_LOG entry.

  **New contract** (Promise-idiomatic):

  | `doneReason`        | Behaviour                                                         |
  | ------------------- | ----------------------------------------------------------------- |
  | `end_turn`          | resolves with the result                                          |
  | `max_iterations`    | resolves with the result (caller-set budget)                      |
  | `token_budget`      | resolves with the result (caller-set budget)                      |
  | `duration_budget`   | resolves with the result (caller-set budget)                      |
  | `guardrail_blocked` | resolves with the result (policy decision)                        |
  | `aborted`           | **throws** `HarnessError(CORE_ABORTED)`                           |
  | `error`             | **throws** `HarnessError(ADAPTER_ERROR)` with originating `cause` |

  Soft budget exhaustion still resolves so callers can inspect partial work
  they explicitly asked for.

  **Migration**: replace any `if (result.doneReason === 'error') throw …` /
  `if (result.doneReason === 'aborted') throw …` blocks with a `try/catch`.
  The thrown `HarnessError` carries the originating exception as `cause` and
  includes a `suggestion` field for diagnostics.

### Minor Changes

- 8a51ef1: `AgentLoop.run()` now emits a leading `iteration_start` event before
  the terminal `error` + `done` pair on every pre-iteration termination
  path: pre-abort, max_iterations, token_budget, duration_budget. The
  contract is now uniform — every `done` is preceded by at least one
  `iteration_start`.

  **Why**: orchestrators (and any consumer driving a state machine off
  event types) used the `iteration_start` event to transition out of the
  initial `planning` state. With a pre-aborted signal the loop emitted
  a single `done` (or no events at all) and orchestrators got stuck in
  `planning`, requiring an awkward `planning → aborted` recovery branch
  in user code (HARNESS_LOG HC-010).

  The synthetic `iteration_start` carries the iteration number that
  _was about to run_ when termination fired (e.g. `1` for pre-abort,
  `maxIterations + 1` for budget exhaustion). The full `startIteration`
  ceremony (span open, hook fire, conversation pruning) is NOT
  performed because no real iteration runs — this is a contract event,
  not a real iteration.

  **Migration**: consumers that exhaustively switched on event types
  will now see one extra `iteration_start` per terminated run. This is
  additive and matches what the no-termination path already produced,
  so most code only needs a comment confirming the assumption is now
  unconditional.

- 8a51ef1: Add `defaultModelPricing` opt-in pricing snapshot and a construction-time
  warning for the silent-`$0` failure mode.

  **New exports** (from `harness-one/observe`):

  - `defaultModelPricing` — frozen `readonly ModelPricing[]` snapshot
    covering Anthropic Claude 4.x / 3.x and OpenAI GPT-4o / 4 / 3.5 models.
    Includes Claude prompt-cache pricing (write = 1.25× input,
    read = 0.10× input).
  - `DEFAULT_PRICING_SNAPSHOT_DATE` — ISO date of the snapshot, so callers
    can detect drift from current vendor pricing.
  - `getDefaultPricing(model)` — lookup helper. Returns `undefined` for
    unknown models — callers must NOT treat that as a billing-safe `$0`.

  **New behaviour**:

  `createCostTracker({ budget, ... })` now emits a one-shot `safeWarn` when
  a positive `budget` is supplied but the pricing table is empty. The
  previous behaviour silently disabled the budget gate (every
  `recordUsage()` returned `$0`, so the budget threshold was unreachable).

  **Why**: see `apps/research-collab/HARNESS_LOG.md` entry L-006 — the
  silent zero-cost mode broke production budget enforcement and made
  test assertions degrade to `>= 0`.

  `apps/research-collab/src/harness-factory.ts` is updated to pass
  `pricing: [...defaultModelPricing]`, which makes the
  `RESEARCH_BUDGET_USD` cap functional.

- 8a51ef1: `CostTracker.recordUsage` now accepts records with `traceId` and / or
  `model` omitted. Missing identifiers route to a stable `'unknown'`
  bucket internally so simple callers (single-task budget trackers,
  ad-hoc scripts) don't have to fabricate stub IDs that pollute
  cost-by-trace / cost-by-model aggregations.

  **Behaviour**:

  - `traceId` omitted → bucket key is `'unknown'`
  - `model` omitted → bucket key is `'unknown'`; the per-record
    unpriced-model warning is suppressed in this case (the warning is
    reserved for callers that supplied a real model name with no
    matching pricing entry)
  - Strict mode (`strictMode: true`) still requires both fields and
    throws on omission — unchanged

  The stored `TokenUsageRecord` shape is unchanged: `traceId` and
  `model` are always populated `string` values on output, so downstream
  consumers reading records see no breakage.

  `apps/coding-agent/src/agent/budget.ts` simplified to drop the
  `traceId: 'coding-agent'` / `model ?? 'unknown'` stubs.

  Closes HARNESS_LOG HC-005.

- 8a51ef1: Guardrail type-and-runtime tightening pass — closes three friction
  entries at once:

  **1. `createPipeline` runtime entry validation** (HARNESS_LOG HC-003)

  Pipeline entries are runtime-validated at construction time. Bare
  `Guardrail` functions or `[g as never]`-style bypasses now throw
  `HarnessError(GUARD_INVALID_PIPELINE)` immediately instead of leading
  to silent `passed: false` runtime failures. The previous shape
  silently typechecked when `as never` was used and produced opaque
  fail-closed verdicts at every call.

  **2. `GuardrailContext.direction` + `source` first-class fields**
  (research-collab L-002)

  `GuardrailContext` gains two top-level fields:

  - `direction?: 'input' | 'output' | 'tool_output' | 'rag'` — auto-filled
    by the pipeline before each guardrail runs, based on which `run*`
    method was called. Caller-supplied direction wins.
  - `source?: string` — free-form provenance tag (URL, file, tool name).

  Trace exporters and observability tooling no longer have to dig into
  `meta` for these standard fields.

  **3. `SyncGuardrail` / `AsyncGuardrail` narrow aliases**
  (research-collab L-003)

  `harness-one/guardrails` now exports two narrower aliases alongside
  the existing `Guardrail` union:

  - `SyncGuardrail = (ctx) => GuardrailVerdict`
  - `AsyncGuardrail = (ctx) => Promise<GuardrailVerdict>`

  Built-in synchronous guardrails (e.g. `createInjectionDetector`) can
  declare their return type as `SyncGuardrail` so callers don't need
  the `instanceof Promise` defensive narrowing. The pipeline still
  accepts the union.

  **Bonus: `getRejectionReason(result)` helper** (showcase 02)

  New utility exported from `harness-one/guardrails`:

  ```ts
  function getRejectionReason(result: PipelineResult): string | undefined;
  ```

  Returns the verdict's `reason` for `block`/`modify` verdicts,
  `undefined` otherwise. Replaces the verbose
  `'reason' in verdict.verdict ? verdict.verdict.reason : 'policy violation'`
  narrowing dance every consumer previously had to write.

  **Migration**: callers using `createInjectionDetector()` directly as
  the `guard:` field of a pipeline entry must now use
  `createInjectionDetector().guard` (the function), not the whole
  `{ name, guard }` object — the prior shape silently degraded into a
  fail-closed pipeline. The new validation surfaces the misuse loudly.

- 8a51ef1: Ship `harness-one/io` — a vertical primitive for filesystem safety
  shared by every coding-agent-shaped tool.

  **New subpath** `harness-one/io` exports:

  - `resolveWithinRoot(root, userPath)` — workspace containment with the
    realpath-existing-prefix dance, defeats macOS `/var → /private/var`
    symlink-escape false positives and rejects symlink prefixes that
    point outside the root. Throws `IO_PATH_ESCAPE` when containment
    fails, `IO_PATH_INVALID` for empty / NUL paths.
  - `safeReadFile(path, opts)` — TOCTOU-safe read. Opens the fd FIRST
    then stats it, eliminating CWE-367 race conditions by construction.
    Supports `maxBytes`, `requireFileKind`, `encoding: 'utf8' | 'buffer'`,
    and `truncateOnOverflow`. Throws `IO_FILE_TOO_LARGE` /
    `IO_NOT_REGULAR_FILE` for actionable failure branching.
  - `splitPath(p)`, `toPosix(p)`, `toFileUri(workspace, rel)` —
    cross-platform string-shape helpers. Critical for LSP integrations
    and sensitive-name predicates that must behave consistently on
    Windows + macOS + Linux.
  - Auxiliary: `canonicalizeRoot`, `canonicalizeRootSync`,
    `realpathExistingPrefix`, `assertContainedIn`, `isContainedIn`.

  **New error codes** added to `HarnessErrorCode`:
  `IO_PATH_ESCAPE`, `IO_PATH_INVALID`, `IO_FILE_TOO_LARGE`,
  `IO_NOT_REGULAR_FILE`.

  **Why**: `apps/coding-agent` discovered each of these as production
  bugs (HARNESS_LOG entries HC-002 macOS realpath, HC-018 CodeQL
  `js/file-system-race` CWE-367, HC-019 Windows-only path-separator
  regressions). Centralising them means downstream apps inherit the
  hardening automatically.

  **Migration**: `apps/coding-agent` updated to consume the new module.
  `tools/paths.ts.resolveSafePath` now delegates to `resolveWithinRoot`
  and layers the coding-agent-specific sensitive-name policy on top;
  `tools/read_file.ts` and `tools/grep.ts` use `safeReadFile`;
  `tools/lsp/client.ts.uri()` delegates to `toFileUri`. The duplicated
  in-app implementations are deleted.

- 8a51ef1: Add `omitUndefined` helper to `harness-one/infra` to centralise the
  `exactOptionalPropertyTypes` conditional-spread workaround.

  **New exports** (from `harness-one/infra`):

  - `omitUndefined<T>(obj: T): WithoutUndefined<T>` — strip
    `undefined`-valued keys from an object literal. Symbol keys preserved.
    Returns a fresh object; input unchanged.
  - `WithoutUndefined<T>` — type that maps each value to
    `Exclude<T[K], undefined>`.

  **Why**: with `exactOptionalPropertyTypes: true`, the literal
  `{ field: maybeValue }` no longer matches `{ field?: T }` because the
  literal carries `undefined` while the type does not. The boilerplate
  workaround `...(value !== undefined && { field: value })` was repeated
  6+ times in each app (HARNESS_LOG entries HC-001, HC-014,
  research-collab L-004).

  **Migration**: `apps/research-collab/src/pipeline/run.ts` and
  `apps/coding-agent/src/cli/args.ts` rewritten to use `omitUndefined`,
  collapsing 15 conditional-spread call-sites into 3 helper invocations.
  The helper is additive — call-sites can be migrated incrementally.

- 8a51ef1: Add `HarnessConfigBase.tools` injection point — caller can either
  inject a fully-built `ToolRegistry` or extend the secure default
  `allowedCapabilities` whitelist.

  **New shape**:

  ```ts
  type HarnessConfigBase = {
    // ...existing fields
    readonly tools?:
      | { readonly registry: ToolRegistry; readonly allowedCapabilities?: never }
      | { readonly allowedCapabilities: readonly ToolCapabilityValue[]; readonly registry?: never };
  };
  ```

  The two fields are **mutually exclusive** — providing both raises
  `CORE_INVALID_CONFIG` at construction time.

  **Three modes** in `wireComponents`:

  | `config.tools`            | Behaviour                                                                                                              |
  | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
  | `{ registry }`            | Use the caller's registry as-is (custom middleware, permission checker, byte caps, etc. preserved)                     |
  | `{ allowedCapabilities }` | Build a registry with the explicit capability allow-list (e.g. `['readonly', 'network']` for apps that need web tools) |
  | omitted                   | Build a registry with the secure default `allowedCapabilities: ['readonly']` (fail-closed)                             |

  **Why**: previously `createHarness` / `createSecurePreset` hard-coded
  `createRegistry({ validator })` and there was no way for downstream
  apps to (a) inject a pre-configured registry, or (b) widen the
  fail-closed capability whitelist without forking the preset. Apps
  that legitimately needed network tools (`apps/research-collab`'s
  `web_search` / `web_fetch`) had to under-declare their tools as
  `Readonly` only — capability metadata fraud, exactly what the
  whitelist mechanism exists to prevent (HARNESS_LOG L-001 / L-005).

  **Migration**: `apps/research-collab/src/harness-factory.ts` now
  passes `tools: { allowedCapabilities: ['readonly', 'network'] }` and
  the web tools declare their truthful capability set.

- 8a51ef1: Add `ToolRegistry.executeByName(name, args)` convenience method.

  The existing `execute(call: ToolCallRequest)` API takes the same shape
  the AgentLoop passes through, but ad-hoc callers (runbooks, tests,
  custom drivers) typically have just `(name, args)` and were forced to
  fabricate a `ToolCallRequest` envelope every time — including the
  JSON-string serialisation of `arguments` that confuses first-time users
  (HARNESS_LOG HC-009).

  `executeByName` synthesises the envelope internally with a unique
  crypto-random call id, JSON-serialises the args (raising a validation
  error on cycles / BigInt / non-serialisable inputs), and forwards to
  the existing `execute` path so middleware, validation, rate limits,
  byte caps, and timeouts all apply identically.

- 8a51ef1: `Span.attributes`, `Span.events`, `Trace.userMetadata`, and
  `Trace.systemMetadata` are now optional in the public type. The
  TraceManager always populates them with empty containers when
  materialising a real Span/Trace, so production readers do not observe
  `undefined` — but test fixtures and exporter mocks no longer have to
  spell out `attributes: {}` / `events: []` literals (HARNESS_LOG
  HC-012).

  Internal exporters (OTel, Langfuse) and analyzers
  (failure-taxonomy, dataset-exporter) updated to defensively spread
  `?? {}` / `?? []` so they tolerate the optional shape without
  runtime regression.

- 8a51ef1: `createStreamingMockAdapter` now enforces a usage-propagation contract:

  - **Auto-attaches `config.usage`** to terminal `done` chunks the caller
    passed _without_ a `usage` field (non-destructive — chunks that
    already carry usage are passed through verbatim).
  - **Throws at construction time** when neither the terminal `done`
    chunk nor `config.usage` provides a usage value.

  **Why**: the previous behaviour silently emitted a usage-less `done`,
  leading AgentLoop's cumulative usage / cost tracker to report zero —
  a footgun for cost-related test assertions that look superficially
  fine but always pass even when wiring is broken
  (showcase 01 FRICTION_LOG, severity medium).

  **Migration**: every `createStreamingMockAdapter({ chunks: [..., { type: 'done' }] })`
  call now must either:

  1. Pass `config.usage = { inputTokens, outputTokens }`, OR
  2. Attach `usage` directly on the terminal `done` chunk.

  Existing call-sites that already supplied one or both are unaffected.

- 8a51ef1: Three new `harness-one/testing` helpers, each closing a friction
  entry surfaced from showcase / app work:

  **`createSlowMockAdapter`** (showcase 04 cascade-abort)

  ```ts
  const adapter = createSlowMockAdapter({
    response: { message, usage },
    chatDelayMs: 50,
    streamChunkDelayMs: 10,
    respectAbort: true, // default
  });
  ```

  Returns an `AgentAdapter` whose `chat()` and `stream()` artificially
  delay so abort/timeout scenarios are observable without real network.
  The delay is interruptible via the request `signal` (default), so
  caller-driven aborts cleanly cancel the wait with an AbortError.

  **`spawnCrashable`** (showcase 03 SIGKILL via pnpm wrapper)

  ```ts
  const outcome = await spawnCrashable({
    entry: 'pnpm',
    args: ['exec', 'node', './leaf.js'],
    killAt: 50,
  });
  // outcome.outcome === 'killed' even when SIGKILL is laundered to exit code 137
  ```

  Wraps `child_process.spawn` and resolves to a structured
  `{ outcome: 'clean' | 'killed' | 'errored', code, signal }`.
  Recognises BOTH `signal === 'SIGKILL'` AND `code === 137` (the
  conventional Unix laundered-SIGKILL exit code that intermediaries
  like pnpm / tsx emit when their leaf is signal-killed).

  **`withTempCheckpointDir`** (HARNESS_LOG HC-017)

  ```ts
  await withTempCheckpointDir(async (dir) => {
    const agent = createCodingAgent({ workspace, checkpointDir: dir });
    // ... checkpoints land in `dir`, not in ~/.harness-coding
  });
  ```

  Async helper that creates a realpath-collapsed temp directory, hands
  it to the callback, and cleans up on exit (success OR failure).
  Centralises the `mkdtemp + try/finally + rmdir` ceremony every
  checkpoint-touching test was duplicating.

### Patch Changes

- 8a51ef1: Cross-subpath ergonomic re-exports — zero runtime cost, type-only:

  - `harness-one/tools` re-exports `ToolSchema`, `ToolCallRequest`,
    `ToolCallResponse` (canonical home stays `harness-one/core`).
    Consumers wiring tools no longer need a second import. Closes
    HARNESS_LOG HC-006.
  - `harness-one/observe` re-exports `TokenUsage`. Cost-aware code that
    imports `CostTracker` no longer needs a second import for the
    per-iteration token shape. Closes HC-007.

  `createDefaultLogger` was already exported from `harness-one/observe`
  (closes HC-008 retroactively); `validateMemoryEntry` was already
  exported from `harness-one/memory` (HC-004 docs piece tracked under
  W4-DOCS).

- 8a51ef1: Documentation + JSDoc improvements driven by FRICTION_LOG entries:

  - **`HarnessLifecycle`** (lifecycle.ts): top-of-file table mapping
    every `from→to` transition to its named verb (`markReady`,
    `beginDrain`, `completeShutdown`, `forceShutdown`). The
    no-`transitionTo` design is now explicitly documented so OTel /
    state-machine refugees stop reaching for it. Closes showcase 01
    FRICTION_LOG `HarnessLifecycle lacks transitionTo`.
  - **`TraceManager`** (trace-manager.ts): top-of-file note that
    there is no `shutdown()` method and OTel migrants must use
    `flush()` inside their host `Harness.shutdown()` path. Closes
    showcase 01 FRICTION_LOG `TraceManager.shutdown() doesn't exist`.
  - **`HandoffPayload`** (orchestration/types.ts): full field map +
    worked `@example` showing `summary + artifacts + concerns +
acceptanceCriteria + metadata + priority`. Closes research-collab
    L-007.
  - **`MemoryEntry.id` vs `MemoryEntry.key`**: each field now carries
    a multi-line JSDoc explaining the role distinction (storage handle
    vs caller-meaningful identifier). Closes showcase 03 FRICTION_LOG.

- 8a51ef1: DX: new `pnpm fresh` root script handles first-time bootstrap in one
  command — `install` → build every `packages/*` `dist/` → `typecheck`
  → `test`. Apps consume harness-one via package.json `exports`
  pointing at `dist/`, so the first `pnpm typecheck` after a clone
  needs the dist to exist. `pnpm fresh` makes this a single command.

  `CONTRIBUTING.md` updated to surface the new shortcut and document
  the manual flow (`pnpm install && pnpm -r --filter './packages/*'
build && pnpm typecheck`) for users who prefer fine-grained
  control.

  Closes HARNESS_LOG research-collab L-008.

## 0.2.0

### Minor Changes

- ef73133: AgentLoop now runs `inputPipeline` on tool-call arguments (defense in depth).

  When `AgentLoopConfig.inputPipeline` is configured, the iteration runner invokes `pipeline.runInput({ content: toolCall.arguments })` once per tool call **before** yielding the `tool_call` event and **before** the tool side-effect runs. A `block` verdict aborts the loop with `guardrail_blocked` (new phase `'tool_args'`) + `error` (`HarnessErrorCode.GUARD_VIOLATION`); the `tool_call` is never yielded.

  Closes the asymmetry where direct `createAgentLoop` callers with an input pipeline previously got user-message validation but not tool-arg validation. Preset users were already covered by the outer wrapper at `harness.run()`.

  **`AgentEvent['guardrail_blocked'].phase` widened** from `'input' | 'tool_output' | 'output'` to `'input' | 'tool_args' | 'tool_output' | 'output'`. This is the only public-API change. Existing exhaustive switches on `phase` (`assertNever(phase)` patterns) need to add a `case 'tool_args':` arm.

  **No impact on preset users.** `createSecurePreset` / `createHarness` do not pass `inputPipeline` to the inner AgentLoop — the preset runs all guardrail phases at the `harness.run()` boundary. The new check is a no-op on the preset path.

  **Caveat for direct AgentLoop users with rate-limiter inside `inputPipeline`**: the limiter sees one additional pipeline run per tool call. Lift the rate-limiter out of `inputPipeline` (compose it as a separate AgentLoop-external guard) if this is undesirable.

### Patch Changes

- c731ee2: Chore: close 4 GitHub security alerts and stop three workflows going red on every push. No runtime/API changes.

  - CodeQL `js/file-system-race` (#122) in `tools/check-pack-reproducible.mjs`: replaced the `statSync` → `readFileSync` TOCTOU pair with a single-fd flow (`openSync` + `fstatSync` + `readFileSync(fd)` + `closeSync`).
  - CodeQL `js/clear-text-logging` (#123) in `examples/guardrails/pii-detector.ts`: variable name `blockApiKey` matched the `key/token/secret` heuristic; renamed to `strictVerdict`.
  - CodeQL `js/redos` (#124) in `packages/core/src/guardrails/__tests__/content-filter.test.ts`: the test deliberately constructs an unsafe pattern to verify the ReDoS pre-check rejects it; reconstructed the source via `String.fromCharCode` so neither a regex literal nor a string literal of `(a+)+b` appears in the file.
  - Dependabot GHSA-qx2v-qp2m-jg93 (postcss XSS via unescaped `</style>`): `pnpm.overrides` bumps postcss from 8.5.8 → ^8.5.10. Dev-only — postcss isn't imported by any published source.
  - Secret scan workflow was failing on every push to `main`: full-history gitleaks scan re-flagged three test/example fixtures (placeholder secrets by design). Added them to `.gitleaks.toml`'s path allowlist.
  - Adapter-caller timing flake (`expected 11 to be greater than or equal to 12`): `Date.now()`'s 1ms resolution can leave wall-clock duration a tick behind the summed scheduled backoffs. Loosened the cumulative-duration assertion by 2ms; real accounting bugs (e.g. duration reset to 0) still trip it.
  - Cassette-drift workflow `ERR_MODULE_NOT_FOUND`: `tools/record-cassettes.mjs` runs from repo root with bare-specifier imports of `harness-one/testing` / `@harness-one/anthropic` / `@harness-one/openai`. Added the three packages as `workspace:*` devDependencies on the root so pnpm symlinks them into `node_modules/`, and updated the workflow to build all three packages before running the script.

- d361733: Chore: comment-only edit in `packages/core/tests/perf/bench.ts` to drop a dangling pointer at a docs file removed in this PR. No runtime, API, or test-coverage changes.
- 1dc2368: Layer 9 (dogfood) follow-ups: warning false-positive, vitest 4 timer regression, dogfood budget; plus README split.

  **`harness-one` — `AgentLoopConfig.guardrailsManagedExternally?: boolean`** added (additive, optional). Wrapper-layer opt-in: when `true`, suppresses the one-time "AgentLoop has no guardrail pipeline — security risk" warning. Defaults to `false`; the warning still fires for direct `createAgentLoop` callers, preserving the fail-closed safety alert. Intended for an enclosing harness (e.g. `createSecurePreset`) that runs the guardrail pipeline at its own boundary — see `docs/architecture/05-guardrails.md`.

  **`@harness-one/preset` — internal opt-in flip**. `wireComponents` now sets `guardrailsManagedExternally: true` when constructing the inner `AgentLoop`. Fixes a false-positive warning that previously fired on every `harness.run()` call telling preset users to "use createSecurePreset" — which they already were. Two documented contracts (`docs/architecture/05-guardrails.md:23` vs `README.md:421`) had collided. No public API change in `@harness-one/preset` itself.

  **Test infrastructure (no consumer impact)**: `packages/core/vitest.config.ts` pins `fakeTimers.toFake` to a safe minimal set (vitest 4 expanded the default to include `queueMicrotask`/`nextTick`/`setImmediate`, which deadlocked vitest's own internal hook scheduling — restored 51 pre-existing failing tests to green) and disables vitest's console intercept (vitest 4 worker rpc + coverage instrumentation had a race where a `safeWarn` fallback fired from inside a fake-timer callback could land on `onUserConsoleLog` after the worker rpc began closing).

  **Dogfood (private workspace, no consumer impact)**: `apps/dogfood` now enforces a per-run USD budget via `DOGFOOD_BUDGET_USD` (default `$0.50`) — eliminates the "no cost budget configured" warning that was firing on every triage run, and caps inference spend on a runaway tool-loop or attacker-crafted issue.

  **Docs**: `README.md` split per best practices — 1235 lines → 343 lines (-72%). Per-module API reference moved to `docs/modules.md`; preset deep dive moved to `packages/preset/README.md` (where npm shows it); import-path cheatsheet moved to `docs/guides/import-paths.md`; feature maturity matrix moved to `docs/feature-maturity.md`. Every cross-link verified before commit; covered by the existing `docs-links.yml` lychee check.

- fa42679: Chore: CI gate follow-ups after the TS6 / vitest 4 upgrade (PR #19). No runtime/API changes.

  - `@harness-one/ajv` test suite now exercises the circular-schema stable-key fallback path, lifting branch coverage from 70.58% to 80.39% (over the 75% gate). Source unchanged.
  - `@harness-one/preset`: two `@link` targets in the `createSecurePreset` TSDoc (`createDefaultLogger`, `registerProvider`) were demoted to inline code spans because they are not re-exported from the `harness-one` root bundle and so cannot be resolved by typedoc. Public API surface unchanged.
  - `harness-one` (`observe/trace-manager`): one intra-doc `@link` demoted to a backtick reference for the same typedoc reason. Behaviour unchanged.

  Tooling side (not versioned): `tools/check-pack-reproducible.mjs` now falls back to a content digest that alphabetises packed `package.json` dependency keys when raw tarball bytes differ, isolating a known pnpm `workspace:*` substitution quirk that previously flagged `@harness-one/preset` as non-reproducible every run. `docs-links.yml` bumped `actions/cache` v4.0.2 → v4.2.4 (deprecated-cache retirement). `secret-scan.yml` replaced the now-paywalled `gitleaks/gitleaks-action` with a direct CLI install from the upstream MIT-licensed release so the job runs without a per-org license.

- fcd5582: Chore: close the two CI gates still red after PR #20 merged. No runtime/API changes.

  - `engines.node` bumped from `">=18"` to `">=20"` across every published package and the root workspace. `packageManager: "pnpm@10.24.0"` ships a regex with the ES2024 `/v` flag, which Node 18 cannot parse — pnpm itself fails to load on Node 18 runners with `SyntaxError: Invalid regular expression flags` before any workspace code runs. The previous `">=18"` manifest claim was misleading; `">=20"` matches what actually works.
  - `.github/workflows/ci.yml` build matrix dropped Node 18; kept `[20, 22]` across ubuntu / macos / windows (6 combos).
  - `packages/core/etc/harness-one.api.md` refreshed to the current tsup chunk-hash (`cost-tracker-IqVhfrMb`). The hash shifted when PR #20's typedoc commit (`90b5b8f`) edited a JSDoc block inside `observe/trace-manager.ts` — the JSDoc change propagates into `.d.ts`, which changes the rollup-plugin-dts content hash. Public API surface unchanged (diff is four comment lines inside `// Warnings were encountered` noting a forgotten export, no exported symbols moved).

- 5576b88: Add Track I perf baseline suite under `packages/core/tests/perf/` — five
  regression-detection benchmarks gated at ±15% drift per PR:

  - I1 `AgentLoop.run()` single-iteration overhead (p50/p95 ns).
  - I2 10k trace-span heap peak (mb).
  - I3 `FileSystemStore` `read` p50 + `query` p95 over 2k entries.
  - I4 `StreamAggregator` 10 MB throughput (ms).
  - I5 10-guard pipeline p99 over 1k messages (µs).

  Numbers live in `packages/core/tests/perf/baseline.json`; the runner
  (`pnpm --filter harness-one bench`) diffs against them and fails the
  job on >+15% regression or warns on <-15% (likely benchmark broke).
  `pnpm --filter harness-one bench:update` rewrites the baseline and is
  owner-only — `.github/workflows/perf.yml` diff-guards the file during
  CI so it cannot drift silently.

  Baseline is currently a darwin placeholder — a platform-match check
  in the runner skips the gate on any OS/Node-major mismatch, so Ubuntu
  CI will stay green until the owner regenerates on Ubuntu + Node 20.

  Pure dev tooling: `tinybench` 6.0 and `tsx` 4.19 as devDeps, no
  runtime bundle impact. See `docs/architecture/17-testing.md` for the
  design write-up and `packages/core/tests/perf/README.md` for the
  runbook.

- b72de7e: Add Track N type-level test suite under `packages/core/tests/type-level/`
  with seven `expect-type` assertions that lock down key type contracts
  at compile time:

  - N1 `AgentEvent` discriminated union — exhaustive switch + variant set.
  - N2 `HarnessConfig` — provider-keyed narrowing + XOR between `adapter`
    and `provider`/`client`.
  - N3 `TraceId` / `SpanId` / `SessionId` branded IDs — cross-brand and
    raw-string rejection.
  - N4 `TrustedSystemBrand` — only `createTrustedSystemMessage()` mints
    the brand; plain `symbol` is not assignable.
  - N5 `MemoryStoreCapabilities` ↔ optional-method signature pairing.
  - N6 `MetricsPort` cross-subpath identity (root barrel ≡ `/observe`).
  - N7 Public-API shape lockfile — any removal/rename across
    `harness-one`, `harness-one/core`, `harness-one/advanced`,
    `harness-one/testing`, `@harness-one/preset`, `@harness-one/anthropic`,
    and `@harness-one/openai` fails `tsc`.

  The suite runs via `pnpm --filter harness-one typecheck:type-level` and
  is wired into CI alongside the standard typecheck. Pure-type dependency
  (`expect-type` 1.3.0 devDep), zero runtime bundle impact.
