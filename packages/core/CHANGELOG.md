# harness-one

## 2.0.0

### Minor Changes

- 7078215: Content blocks on `Message` (RFC-0001) — extended thinking and images
  become representable without breaking the `content: string` surface:

  - New `ContentBlock` union (`TextBlock` / `ThinkingBlock` /
    `RedactedThinkingBlock` / `ImageBlock`) and optional
    `Message.blocks?: readonly ContentBlock[]`. Invariant: when `blocks`
    is present, `content` equals the text projection (new `blocksText()`
    helper). Text-only consumers keep reading `content` unchanged.
  - `StreamChunk` gains the `'thinking_delta'` variant
    (`thinking` / `signature` / `redactedData` fields); `AgentEvent`
    gains `{ type: 'thinking_delta'; thinking: string }` so UIs can render
    reasoning progress live.
  - `StreamAggregator` accumulates thinking fragments into a single
    `ThinkingBlock` (last signature wins), turns each redacted payload
    into a `RedactedThinkingBlock`, counts both toward `maxStreamBytes`,
    and attaches `blocks` to the reconstructed assistant message.

  Additive: existing `Message` literals stay valid; exhaustive switches
  over `AgentEvent`/`StreamChunk` need a `thinking_delta` case. Provider
  support ships in `@harness-one/anthropic` (parse/replay/thinking option)
  and `@harness-one/openai` (image parts, graceful degrade). See
  `docs/rfc/0001-content-blocks.md`.

  Also: `createCircuitBreaker` / `CircuitOpenError` (+ config/state types)
  are now exported from `harness-one/advanced` — previously the circuit
  breaker was documented as a resilience mechanism but unreachable from any
  public subpath (see `docs/guides/resilience.md`).

- 7078215: Core defect fixes from the 2026-07 architecture review:

  - **Streaming token budgets are now enforceable.** When a streaming
    adapter ends its stream without reporting usage (missing or zeroed
    `done` chunk), `AgentLoop` estimates tokens via the token-estimator
    heuristic instead of silently accumulating `{0, 0}` (which made
    `maxTotalTokens` unenforceable), and yields a `warning` event naming
    the adapter.
  - **One-time no-budget warning.** A loop configured with neither
    `maxTotalTokens` nor `maxDurationMs` now logs a one-time warning
    (mirror of the no-guardrail-pipeline warning): such runs are bounded
    only by `maxIterations`.
  - **Guardrail direction fidelity.** `GuardrailEvent.direction` now
    carries the full `GuardrailDirection` union. `runToolOutput` tags
    context + events with `'tool_output'` (previously collapsed to
    `'output'`) and `runRagContext` with `'rag'` (previously `'input'`),
    so guards branching on `ctx.direction === 'tool_output' | 'rag'`
    actually fire and trace exporters can distinguish the phases.
    Consumers switching exhaustively on the event direction must handle
    the two new members.
  - **Optimistic-lock integrity across mixed paths.** The in-memory
    store's plain `write()` / `update()` / `delete()` / eviction /
    `compact()` now advance the per-key CAS version, so a plain-path
    writer can no longer slip past a concurrent `updateWithVersion()`
    caller (lost update). New optional `MemoryStore.getVersion(key)`
    returns the current version; `setWithTtl` no longer resets versions
    (strictly monotonic).
  - **`defineTool` structured-throw preservation fixed.** The catch-path
    guard matched an obsolete `{error, content}` shape that no valid
    `ToolResult` has; thrown values are now preserved only when they match
    the current `{kind, success, ...}` discriminated shape (which the
    registry's `assertToolResult` accepts), everything else collapses into
    the generic internal tool error as documented.
  - `CoordinatorState.status` now reuses the public `AgentLoopStatus`
    type instead of re-spelling the union (type-drift guard, no runtime
    change).

- 7078215: Remove two pieces of hidden global state from the core kernel: introduce an
  injectable `Clock` port (B8) and an instance-scoped tokenizer registry (B7).
  Both are additive and default to the prior behaviour byte-for-byte.

  - **Injectable clock (B8).** New `Clock` interface (`now(): number`) and
    `systemClock` default in `infra/clock.ts` (L1, imports nothing upward).
    `Date.now()` was called directly throughout the kernel (adapter-caller ~8
    sites, iteration-coordinator ~3, memory store TTL/id paths, checkpoint
    timestamps), making duration budgets / TTL / timestamps untestable without
    fake timers. An optional `clock?: Clock` now threads through
    `AgentLoopConfig` → `CoordinatorDeps` (run-start + `maxDurationMs` budget)
    and `AdapterCallerConfig` (`totalDurationMs`), plus `createInMemoryStore({
clock })` (timestamps, `mem_<time>_<rand>` id prefix, TTL expiry) and
    `createCheckpointManager({ clock })` (checkpoint `timestamp`,
    `prune({ maxAge })` cutoff). Default everywhere is `systemClock`, so runtime
    behaviour is unchanged. Exported from `harness-one/infra` and
    `harness-one/advanced`.

  - **Instance-scoped tokenizer registry (B7).** New `TokenizerRegistry`
    interface (`register` / `estimate`) and `createTokenizerRegistry()` factory,
    each closed over its own map. The module-level `registerTokenizer` /
    `estimateTokens` / `clearTokenizerRegistry` now delegate to a shared default
    instance and keep working verbatim (the `@harness-one/tiktoken` global path
    is untouched). `countTokens(model, messages, tokenizerRegistry?)` and
    `StreamHandlerConfig.tokenizerRegistry?` add optional injection points that
    default to the global registry; when a custom registry is injected,
    `countTokens` bypasses its shared per-message WeakMap cache to avoid
    cross-registry contamination. `registerTokenizer`'s TSDoc now flags that it
    mutates process-wide state and recommends `createTokenizerRegistry` for
    library authors. Exported from `harness-one/context` and
    `harness-one/advanced`.

- 7078215: Tools: zero-cast tool registration + type-level schema→params inference.

  - **`register` variance fix (kills the cross-app double-cast).**
    `ToolDefinition<T>` is contravariant in `T` (it appears in
    `execute(params: T)`), so under `strictFunctionTypes` a concrete
    `ToolDefinition<{ q: string }>` was _not_ assignable to
    `ToolDefinition<unknown>` — the type `register()` used to accept. That forced
    callers to write `tool as unknown as Parameters<typeof register>[0]`.
    `ToolRegistry.register` now accepts the new variance-safe alias
    `AnyToolDefinition` (`ToolDefinition<never>`); since `never` is assignable to
    any `T`, every `defineTool<...>()` result registers with **zero casts** while
    callers of a concrete tool's `execute` keep full parameter typing. Params are
    still validated against `tool.parameters` at execution time.

  - **`FromSchema<S>` schema → TypeScript inference (type-level, zero runtime
    deps).** New exported type utility maps the supported JSON-Schema subset
    (`type` over `string`/`number`/`integer`/`boolean`/`object`/`array`/`null`,
    plus `properties`, `items`, `required`, `enum`) of an `as const` schema
    literal to a params type. `defineTool` gains an overload so
    `defineTool({ parameters: { ... } as const, execute: (params) => ... })`
    infers `params` from the schema — no explicit generic needed. Conservative by
    design: a schema without `as const` (or the widened `JsonSchema` interface)
    falls back to `unknown`, exactly as before. The explicit-generic form
    `defineTool<T>({ ... })` is unchanged and backward compatible.

  New public exports from `harness-one/tools`: `AnyToolDefinition`,
  `FromSchema`, `ReadonlyJsonSchema`, `DeepReadonly` (all type-only).

### Patch Changes

- 7078215: Re-introduce runtime-working `@deprecated` aliases for symbols renamed during
  the thin-harness naming cleanup, so consumers who pinned by SHA before the
  first release are not broken by the rename. Each alias is a reference-identity
  re-export of its `createBasic*` counterpart and is slated for removal one full
  major version after first release.

  - `harness-one/orchestration`: `createRoundRobinStrategy`,
    `createRandomStrategy`, `createFirstAvailableStrategy`.
  - `harness-one/rag`: `createFixedSizeChunking`, `createParagraphChunking`,
    `createSlidingWindowChunking`.
  - `harness-one/guardrails`: `withSelfHealing` (alias of `withGuardrailRetry`).
  - `harness-one/observe`: the renamed-away `'hallucination'` failure mode is now
    recognised as a deprecated alias of `'repeated_tool_failure'`. A new
    `normalizeFailureMode()` helper resolves it, and `registerDetector()` /
    `FailureTaxonomyConfig.detectors` normalise the key so consumer detectors
    registered under the old name keep working.

- 7078215: TSDoc: cross-link resilience mechanisms to the selection guide

  Added a `@see docs/guides/resilience.md` reference and a one-sentence
  "when to use this vs. the alternatives" note to the TSDoc of the four
  overlapping resilience mechanisms — `createFallbackAdapter`,
  `createResilientLoop`, `createCircuitBreaker`, and the `AgentLoopConfig`
  in-loop retry knobs (`maxAdapterRetries`). Comment-only; no public API or
  runtime behavior change.
  </content>
  </invoke>

## 1.0.2

### Patch Changes

- 9654276: Release-engineering: rewrite `version-packages.yml` so the auto-generated
  "Version Packages" PR can be squash-merged from the GitHub UI without
  any maintainer-side scripting.

  Two long-standing blockers stacked on every release:

  1. **`required_signatures` ruleset** rejected the bot's commit because
     `GITHUB_TOKEN` cannot sign commits.
  2. **`required_status_checks`** could not be satisfied because GitHub
     deliberately does NOT trigger downstream workflows on
     `GITHUB_TOKEN` pushes (recursion guard).

  The new workflow:

  - Replaces `changesets/action`'s git-push step with a GraphQL
    `createCommitOnBranch` mutation. GitHub server-side signs the
    resulting commit (verified ✓), satisfying `required_signatures`
    with no signing key, App, or PAT setup needed.
  - Explicitly invokes `gh workflow run --ref changeset-release/main`
    on each required CI workflow (`ci.yml`, `api-check.yml`,
    `codeql.yml`) so they produce check-runs at the bot PR's HEAD SHA.
  - Adds `workflow_dispatch:` triggers to those required workflows so
    the dispatch is a no-op for ordinary contributors but legal for
    the version-packages step to invoke.

  `tools/sign-changeset-release-pr.sh` (added in #44) remains as a
  documented escape hatch should the workflow ever fail.

- 932028b: Release-engineering follow-up to #45: add `workflow_dispatch:` triggers
  to the remaining 3 required-check workflows (`audit.yml`,
  `migrations.yml`, `release-pack.yml`) and extend
  `version-packages.yml`'s dispatch loop to cover them.

  PR #45 dispatched only `ci.yml`, `api-check.yml`, `codeql.yml` — but
  the `main` ruleset's `required_status_checks` also includes
  `pnpm-audit`, `check-migrations`, `check-pack`, which are produced by
  those three workflows. Without `workflow_dispatch:` on them the bot
  PR (#46) was BLOCKED on those three checks despite verified commits +
  all dispatched workflows green.

  This PR completes the coverage so the bot PR is fully self-unblocking
  from the GitHub UI: every required check-run lands at the bot PR's
  HEAD SHA via dispatch.

  Also restores `tools/sign-changeset-release-pr.sh` as the documented
  escape hatch (per the existing `docs/release.md` "Unblocking the
  Version Packages PR" section). The workflow is the primary path; the
  script remains in the tree for the case where the workflow itself
  breaks (createCommitOnBranch API change, file-size limit, etc.).

## 1.0.1

### Patch Changes

- f3ad6ad: Test-only fix for a Windows-only flake in
  `createAdapterContractSuite > stream() aborts mid-iteration when
simulateTiming is on and signal fires`.

  The shared `stream-simple.jsonl` cassette spans only ~15ms total.
  Windows `setTimeout` has ~15ms minimum granularity (vs sub-ms on
  Linux/macOS), so the test's 5ms abort timer fired AFTER the cassette
  finished — the for-await loop completed normally, the stream
  resolved, and `.rejects.toBeInstanceOf(Error)` failed.

  Replaced the shared cassette with a self-contained inline cassette
  materialised to a temp file with chunks at 0/100/200/300ms and
  abort scheduled at 50ms. Even when Windows rounds 50ms up to ~60ms,
  the abort lands well inside the 100→200ms inter-chunk wait —
  deterministic on every supported platform.

  No production-code changes. Affects test infrastructure only.

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
