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
