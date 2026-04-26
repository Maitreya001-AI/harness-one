# `apps/coding-agent` HARNESS_LOG

> Per `docs/coding-agent-DESIGN.md` §6.1 and `docs/harness-one-app-feedback-loop.md`,
> every friction encountered while building the coding agent against `harness-one`
> is logged here so the framework team can prioritise reuse-back work.
>
> **Format**: one entry per friction.  
> Required fields: `id` / `stage` / `severity` / `summary` / `details` / `repro` /
> `workaround` / `requested-fix` / `status`.
>
> **Severity scale**:
> - `blocker` — coding-agent cannot ship without a fix
> - `friction` — costs time, has a workaround
> - `paper-cut` — minor inconvenience, ergonomic only

## Index

| ID | Stage | Sev | Summary | Status |
|---|---|---|---|---|
| HC-001 | S3 | paper-cut | exactOptionalPropertyTypes friction with conditional `AbortSignal` | logged |
| HC-002 | S3 | friction | macOS `/var → /private/var` realpath escape leaks into tool path math | logged |
| HC-003 | S4 | paper-cut | `createPipeline` accepts `{name, guard}` items but a bare `Guardrail` typechecks loosely | logged |
| HC-004 | S5 | paper-cut | `validateMemoryEntry` discoverability — only via `harness-one/memory`, not the root barrel | logged |
| HC-005 | S6 | friction | `CostTracker.recordUsage` requires `traceId` + `model` even when caller is single-task | logged |
| HC-006 | S6 | paper-cut | `ToolSchema` lives in `harness-one/core`, not `harness-one/tools` (where consumers expect it) | logged |
| HC-007 | S6 | paper-cut | `TokenUsage` lives in `harness-one/core`, not re-exported from `observe` | logged |
| HC-008 | S6 | paper-cut | No `createDefaultLogger`; every consumer types `createLogger()` with no args | logged |
| HC-009 | S6 | friction | `registry.execute` takes a `ToolCallRequest` not `(name, args, signal)` — surprises every caller | logged |
| HC-010 | S6 | friction | AgentLoop pre-aborted signal yields no `iteration_start`; orchestrators that key on it stay in start state | logged |
| HC-011 | S7 | friction | `readline` + `PassThrough` interactions emit `line` after `close` unpredictably under tests | logged |
| HC-012 | S8 | paper-cut | `Span.attributes` non-nullable in the public type even though most call-sites would prefer optional | logged |
| HC-013 | S11 | paper-cut | tsup minify + `#!/usr/bin/env node` shebang preservation isn't documented; need explicit `minify: false` for bin entries | logged |
| HC-014 | S12 | paper-cut | exactOptionalPropertyTypes again — empty arrays vs `undefined` for spread-conditional config (`tagFilter`, etc.) | logged |
| HC-015 | S13 | friction | No reusable JSON-RPC + LSP-framing primitive in `harness-one`; every tool integration re-implements it | logged |
| HC-016 | S14 | paper-cut | tsup CJS output extension defaults to `.cjs` for `type: module` packages, but VS Code's `main` resolution needs `.js` — silent fail when forgotten | logged |
| HC-017 | S14 | paper-cut | `harness-one-coding`'s `checkpointDir` option is the only test seam for the default `~/.harness-coding/` path; downstream apps' tests need an explicit override or they pollute the user's home | logged |
| HC-018 | post-PR | friction | No `harness-one/io/safe-read` helper — TOCTOU `fs.stat` + `fs.open` race (CWE-367) recurs in every fs-reading tool downstream apps build | logged |

---

## HC-018 · No `safe-read` helper — every fs-reading tool re-discovers the TOCTOU trap

- **Stage**: post-PR (CodeQL high-severity alerts on #33)
- **Severity**: friction
- **Summary**: GitHub's CodeQL `js/file-system-race` (CWE-367) flagged
  both `read_file` and `grep` tools for the classic `fs.stat()` →
  `fs.open()/readFile()` race. The tools used `stat` to (a) confirm the
  target was a regular file, or (b) check size against a cap, then
  read the contents in a separate syscall. An attacker who controls
  the workspace can swap the path between the two calls.
- **Details**: We fixed both call-sites by opening first and statting
  the file descriptor. The same pattern will recur in every coding-
  agent-shaped tool that wants to enforce "this is a regular file"
  or "this is under N bytes" before reading. A `harness-one/io/
  safeReadFile(path, { maxBytes, requireFileKind })` helper would
  centralise the fd-first idiom.
- **Repro**: see `apps/coding-agent/src/tools/{read_file,grep}.ts`
  commits before/after the post-PR fix.
- **Workaround**: open → `fh.stat()` → `fh.read*()` per call-site.
- **Requested fix**: Ship `harness-one/io/safe-read` (or fold into the
  same module that handles `path-safety`, since both protect against
  workspace-escape attacks). Same vertical-package candidate shape as
  HC-002 and HC-015.
- **Status**: logged.

---

## HC-017 · `checkpointDir` is the only seam for sandboxing tests

- **Stage**: S14 (VS Code extension tests)
- **Severity**: paper-cut
- **Summary**: When unit tests build a `CodingAgent` they must remember
  to pass `checkpointDir` — otherwise the test pollutes
  `~/.harness-coding/checkpoints` with junk entries that subsequently
  contaminate tests like "no checkpoints found" assertions.
- **Details**: The first iteration of the VS Code extension's
  `collectListReport` test failed because real checkpoints from
  unrelated runs were already on disk. The fix is to pipe an explicit
  `checkpointDir: tempdir` through every test, but downstream apps
  building on top of `harness-one-coding` will all hit this trap.
- **Repro**: see `apps/coding-agent-vscode/tests/extension.test.ts` —
  every test now creates a temp checkpoint dir.
- **Workaround**: every test creates a temp dir + passes
  `checkpointDir`.
- **Requested fix**: Either default `checkpointDir` to a process-scoped
  temp dir when `NODE_ENV === 'test'`, OR document the gotcha
  prominently in the README "Configuration knobs" table.
- **Status**: logged.

---

## HC-016 · tsup CJS output extension defaults to `.cjs` for ESM-typed packages

- **Stage**: S14 (VS Code extension build)
- **Severity**: paper-cut
- **Summary**: When `package.json` declares `"type": "module"` (so the
  source is treated as ESM), tsup emits CJS output as `.cjs`. VS Code
  resolves the extension's `main` field via legacy CommonJS rules and
  refuses `.cjs`, requiring `.js` even for CJS bundles.
- **Details**: Silent fail — the extension just doesn't activate, no
  diagnostic. Discovered only because we typed `dist/extension.js` in
  the manifest and saw the build output `extension.cjs` instead.
- **Repro**: see `apps/coding-agent-vscode/tsup.config.ts` —
  `outExtension: () => ({ js: '.js' })` is the workaround.
- **Workaround**: explicit `outExtension` override.
- **Requested fix**: Document this trap in the form-coverage doc that
  covers vertical-package CLIs / extensions. Possibly factor a shared
  `extensionTsupConfig` helper into a tooling package once 2+
  extensions exist.
- **Status**: logged.

---

## HC-001 · `exactOptionalPropertyTypes` + optional `AbortSignal`

- **Stage**: S3 (tools / shell)
- **Severity**: paper-cut
- **Summary**: Constructing a `RunArgs` struct that has `externalSignal?: AbortSignal`
  is rejected when the source is `AbortSignal | undefined`. Forces a verbose
  conditional-spread pattern.
- **Details**: With `exactOptionalPropertyTypes: true` (inherited from
  `tsconfig.base.json`), `{ externalSignal: maybeSignal }` no longer matches
  `{ externalSignal?: AbortSignal }` because the literal carries
  `undefined` while the type does not include `undefined`. Same friction
  appears in dogfood (`spread iff value !== undefined` pattern is repeated
  ~10 times across the monorepo).
- **Repro**: see `apps/coding-agent/src/tools/shell.ts` commit history —
  the `runArgs: RunArgs = { ..., ...(externalSignal !== undefined && { externalSignal }) }`
  pattern is verbose and easy to forget when wiring a new tool.
- **Workaround**: conditional spread per call-site.
- **Requested fix**: Either (a) a tiny utility in `harness-one/infra` like
  `omitUndefined<T>(obj: T): T` so call-sites read cleanly, or (b) re-evaluate
  whether `exactOptionalPropertyTypes` is worth the friction it adds for
  every "I have an `AbortSignal | undefined`" call-site. Option (a) is the
  least-disruptive.
- **Status**: logged.

---

## HC-002 · macOS `/var → /private/var` realpath escape

- **Stage**: S3 (tools / paths)
- **Severity**: friction
- **Summary**: A workspace path resolved via `path.resolve()` does **not**
  match the same path returned by `fs.realpath()` on macOS, because
  `/var/folders/...` is a symlink to `/private/var/folders/...`. The first
  iteration of `resolveSafePath` therefore raised "Path escapes workspace"
  for every legitimate temp-dir-based test.
- **Details**: This is not strictly a `harness-one` defect — it's a Node.js
  surprise that any path-containment guardrail will hit. But because
  guardrails *are* in `harness-one`'s scope, an analogous helper there
  would save every downstream agent author from re-discovering the trap.
- **Repro**: `fs.mkdtemp(os.tmpdir())` on macOS, then
  `path.relative(workspace, await fs.realpath(targetInsideWorkspace))`
  returns `../../../../private/var/...`.
- **Workaround**: `canonicalizeWorkspaceAsync` realpaths the workspace once
  at agent boot; `resolveSafePath` realpaths the deepest existing ancestor
  of every userPath; tests realpath the temp dir before passing to ctx.
- **Requested fix**: Ship a `resolveWithinRoot(root, userPath)` helper
  in `harness-one/infra` (or a future `harness-one/fs-safety` subpath)
  with the realpath dance built in. Every coding-agent-shaped app will
  need this primitive.
- **Status**: logged. App workaround is permanent; infra request is open.

---

## HC-015 · No reusable JSON-RPC + LSP-framing primitive

- **Stage**: S13 (LSP tools)
- **Severity**: friction
- **Summary**: Implementing `lsp_definition` / `lsp_references` required
  hand-rolling the Content-Length-prefixed JSON-RPC over stdio framer
  in 200+ lines (`src/tools/lsp/client.ts`). Other coding-agent-shaped
  apps (Cursor / Aider / Cline analogues) will all need the same
  primitive — vertical-package candidate.
- **Details**: The framing isn't hard, but pending-request tracking,
  timeout-with-cleanup, error-class mapping, and exit-on-disconnect
  semantics all involve fiddly subprocess-lifecycle logic. Consolidating
  this into a `harness-one/io/jsonrpc-stdio` module would let
  downstream apps focus on tool semantics, not transport plumbing.
- **Repro**: see the size of `apps/coding-agent/src/tools/lsp/client.ts`
  vs the high-level tool definitions in `lsp-tools.ts`.
- **Workaround**: ship per-app implementation.
- **Requested fix**: After 2+ apps need this primitive, promote to
  `harness-one/io` with a full test suite. Same shape as
  `harness-one/redact` — small, focused, reusable, type-safe.
- **Status**: logged.

---

## HC-014 · `exactOptionalPropertyTypes` keeps biting on conditional spreads

- **Stage**: S12 (eval runner)
- **Severity**: paper-cut
- **Summary**: Same shape as HC-001. With `exactOptionalPropertyTypes: true`,
  passing a possibly-empty array under a `?` key requires the
  `...(arr.length > 0 && { tagFilter: arr })` dance instead of
  `tagFilter: arr`. Repeated ~6× across this codebase already.
- **Details**: This trips up new contributors too — every "I have an
  optional config field that I want to set conditionally" reaches for
  the conditional spread, but the recipe is unobvious.
- **Repro**: Try `runEval({ fixtures, tagFilter: [] })` against the
  current type — TS rejects when the field is `string[] | undefined`
  and the input is plain `string[]` because `[]` widens to never-typed.
- **Workaround**: conditional spread.
- **Requested fix**: Same as HC-001 — ship an `omitUndefined` /
  `compact` helper in `harness-one/infra` so call-sites read cleanly.
  Possibly even codemod existing call-sites in `apps/dogfood`,
  `apps/coding-agent`.
- **Status**: logged.

---

## HC-013 · `tsup` shebang preservation under minify

- **Stage**: S11 (build pipeline)
- **Severity**: paper-cut
- **Summary**: `tsup` minify mode strips comments but the shebang is
  preserved on entry files only when `minify: false` (or via the
  `banner` config). Discovered while wiring `dist/cli/bin.js` — the
  shebang survived only because we set `minify: false`. Worth a
  one-liner in the harness-one ARCHITECTURE bundling guide.
- **Details**: dogfood has no bin so it doesn't hit this; coding-agent
  is the first vertical package with a CLI binary that ships through
  tsup.
- **Repro**: enable `minify: true` for an entry that begins with
  `#!/usr/bin/env node`; the shebang is dropped.
- **Workaround**: `minify: false` for now (CLI source is small enough).
- **Requested fix**: Document the shebang-preservation pattern in
  `docs/harness-one-form-coverage.md` or wherever vertical-package
  bundling lives. Optionally tsup's own docs already cover this; just
  link to it from harness-one.
- **Status**: logged.

---

## HC-012 · `Span.attributes` is non-optional but rarely populated

- **Stage**: S8 (observability)
- **Severity**: paper-cut
- **Summary**: Building a synthetic `Span` for the JSONL exporter unit
  test forced an empty `attributes: {}` literal. Same for `events: []`.
  Most consumers skip these fields in real life.
- **Details**: For exporters the field is never undefined, but for test
  doubles the `{}` boilerplate is duplicate.
- **Repro**: see `tests/unit/jsonl-exporter.test.ts` — every Span
  literal carries `attributes: {}, events: []`.
- **Workaround**: literal `{}` / `[]`.
- **Requested fix**: Mark `attributes` and `events` optional in
  `observe/types.ts` and default them to `{}` / `[]` at trace-manager
  level. Same for `Trace.userMetadata` / `systemMetadata`.
- **Status**: logged.

---

## HC-011 · readline + PassThrough timing is fragile

- **Stage**: S7 (CLI signals + auditor)
- **Severity**: friction
- **Summary**: When the auditor's interactive prompt was implemented
  with `readline.createInterface({ input, output, terminal: false })`,
  tests piping data via `PassThrough.end('y\n')` non-deterministically
  emitted `close` before `line`, causing the auditor to resolve as
  "stdin closed before answer" instead of "user said yes".
- **Details**: Not a `harness-one` defect, but reach-able if
  `harness-one` ever ships an interactive helper.
- **Repro**: see the original draft of
  `apps/coding-agent/src/guardrails/auditor.ts` (now refactored to
  read raw `data` events).
- **Workaround**: replaced readline with manual buffer + `\n` split.
- **Requested fix**: Avoid recommending readline for non-tty
  test seams. If `harness-one` adds an interactive primitive, build it
  on raw stream `data` events.
- **Status**: logged.

---

## HC-010 · AgentLoop emits no `iteration_start` on pre-aborted signal

- **Stage**: S6 (run-task orchestrator)
- **Severity**: friction
- **Summary**: When the consumer's `signal` is already aborted before
  `loop.run()` is invoked, the AgentLoop yields a single `done` (or no
  events at all) without an `iteration_start`. Orchestrators that
  bootstrap state machines on `iteration_start` get stuck in their
  initial state and need a fall-through branch.
- **Details**: We rely on `iteration_start` to transition `planning →
  executing`. Pre-aborted signals leave us in `planning`, which the
  state machine forbids transitioning to `done` directly. We had to
  add a `planning → aborted` recovery branch in `loop.ts`.
- **Repro**: see `tests/integration/run-task.test.ts > respects
  external AbortSignal`.
- **Workaround**: orchestrator detects pre-aborted state and forces a
  `planning → aborted` transition.
- **Requested fix**: Either (a) AgentLoop should still emit at least
  one `iteration_start` event before aborting, OR (b) document the
  empty-event-stream case in `AgentLoopHook` so consumers know to
  handle it.
- **Status**: logged.

---

## HC-009 · `registry.execute` takes a `ToolCallRequest`, not `(name, args)`

- **Stage**: S6 (loop / onToolCall bridge)
- **Severity**: friction
- **Summary**: The intuitive shape for "run this tool" is
  `registry.execute(toolName, args, options)`. The actual API is
  `registry.execute({ id, name, arguments })` where `arguments` is a
  JSON string. Discovered only after typecheck failed.
- **Details**: Caller already has the `ToolCallRequest` from the
  AgentLoop, so this is the more natural fit if you're writing the
  bridge. But for ad-hoc tool execution (tests, runbooks, custom
  drivers) the shape is awkward.
- **Repro**: see git history of `apps/coding-agent/src/agent/loop.ts`
  — first iteration tried `registry.execute(call.name, args, {signal})`.
- **Workaround**: build a synthetic `ToolCallRequest`.
- **Requested fix**: Add an `executeByName(name, args, options?)`
  convenience method on the registry that handles the JSON
  serialisation internally.
- **Status**: logged.

---

## HC-008 · No `createDefaultLogger`

- **Stage**: S6 (factory wiring)
- **Severity**: paper-cut
- **Summary**: dogfood uses `createDefaultLogger` from
  `harness-one/observe`. coding-agent typed the same import — TS
  rejected. The actual export is `createLogger`. The two coexist in
  internal-only files but only `createLogger` is publicly exported.
- **Details**: There IS a `createDefaultLogger` inside
  `infra/logger.ts` but it's not in the public barrel. preset's
  internal code uses it; consumers can only see `createLogger`.
- **Repro**: typecheck error in early draft of `src/agent/index.ts`.
- **Workaround**: use `createLogger()` (defaults are fine).
- **Requested fix**: Either expose `createDefaultLogger` publicly or
  rename the existing `createLogger` factory to make the "with sane
  defaults" intent obvious.
- **Status**: logged.

---

## HC-007 · `TokenUsage` not exported from `harness-one/observe`

- **Stage**: S6 (budget tracker)
- **Severity**: paper-cut
- **Summary**: `TokenUsage` is the canonical type for "tokens consumed
  by an iteration". A consumer wiring observability subsystems
  reasonably reaches for `harness-one/observe`. The actual home is
  `harness-one/core`.
- **Details**: This is a deliberate "core defines, observe consumes"
  split, but consumer ergonomics suffer — every cost-aware module
  imports `TokenUsage` from `harness-one/core` and `CostTracker` from
  `harness-one/observe`. Two imports for one logical concern.
- **Repro**: typecheck error during S6.
- **Workaround**: dual import.
- **Requested fix**: Re-export `TokenUsage` from `harness-one/observe`
  as a type-only re-export (zero runtime cost).
- **Status**: logged.

---

## HC-006 · `ToolSchema` not in `harness-one/tools`

- **Stage**: S6 (loop wiring tools into AgentLoop)
- **Severity**: paper-cut
- **Summary**: To convert a `ToolDefinition` into the `ToolSchema`
  shape the AgentLoop expects, callers reach for
  `harness-one/tools`. The type lives in `harness-one/core`.
- **Details**: Same shape as HC-007 — dual-import friction. AgentLoop
  consumes `ToolSchema`; tool authors consume `ToolDefinition`. But
  the bridge code that builds the schema list lives in user code.
- **Workaround**: dual import.
- **Requested fix**: Re-export `ToolSchema` from `harness-one/tools`.
- **Status**: logged.

---

## HC-005 · `CostTracker.recordUsage` shape requires `traceId` + `model`

- **Stage**: S6 (budget tracker)
- **Severity**: friction
- **Summary**: `recordUsage` requires `traceId` and `model` even when
  the caller is a simple budget tracker that has neither (the agent
  may not have a trace yet, and model is best-effort).
- **Details**: Forces every cost-aware caller to fabricate a stub
  `traceId: 'coding-agent'` + `model: model ?? 'unknown'`. The
  fabricated values then leak into the cost-by-model / cost-by-trace
  buckets, polluting metrics.
- **Repro**: see `apps/coding-agent/src/agent/budget.ts` —
  `traceId: 'coding-agent'` is a stub.
- **Workaround**: stub fields.
- **Requested fix**: Make `traceId` and `model` optional on
  `recordUsage`. The tracker has reasonable fallbacks already
  (`'unknown'` model bucket).
- **Status**: logged.

---

## HC-004 · `validateMemoryEntry` only discoverable via deep import

- **Stage**: S5 (checkpoint manager)
- **Severity**: paper-cut
- **Summary**: To validate a memory entry envelope (defence-in-depth
  against corrupted on-disk JSON) the canonical helper is
  `validateMemoryEntry`. It's exported from `harness-one/memory` but
  not the root barrel, and not mentioned in
  `docs/harness-one-form-coverage.md`. Consumers find it only by
  grepping the source.
- **Details**: This is the right helper but the discoverability is
  poor; we found it only because the schema-validation guard lives
  next to `MemoryStore` in the source.
- **Repro**: search `docs/` for `validateMemoryEntry` — zero hits.
- **Workaround**: deep-import from `harness-one/memory`.
- **Requested fix**: Document the validators in the public memory
  guide and consider re-exporting from the root barrel under the
  "schema guards" header alongside `MemoryStore`.
- **Status**: logged.

---

## HC-003 · `createPipeline` entry shape isn't enforced at the type level

- **Stage**: S4 (guardrails / policy)
- **Severity**: paper-cut
- **Summary**: `createPipeline({ input: [...] })` expects each entry to be
  `{ name, guard, timeoutMs? }`, but passing a bare `Guardrail` function
  typechecks. The pipeline then runs an entry with `entry.guard ===
  undefined` and silently fails at runtime — in `failClosed` mode every
  call returns `passed: false` with no useful diagnostic.
- **Details**: Discovered while wiring the coding agent's input/output
  pipelines. First iteration passed `[dangerousGuardrail]` directly; tests
  surfaced the bug only because clean content unexpectedly returned
  `passed: false`.
- **Repro**: 
  ```ts
  const g: Guardrail = (ctx) => ({ action: 'allow' });
  const p = createPipeline({ input: [g as never] });
  await p.runInput({ content: 'x' }); // → { passed: false }
  ```
- **Workaround**: pass `{ name, guard }` shapes explicitly.
- **Requested fix**: Either tighten the parameter type so a bare function
  is a TS error, OR auto-wrap bare functions as
  `{ name: 'anonymous', guard }`. The second form is more forgiving and
  matches what most callers will reach for first.
- **Status**: logged.

---

## Recording new entries

When you hit friction during implementation:

1. Pick the next free `HC-NNN` id.
2. Add a row to the **Index** with status `logged`.
3. Add a full section below with the eight required fields.
4. Reference the entry from any code comment that documents the workaround.

The `RETRO/` directory aggregates these quarterly into reuse-back proposals.
