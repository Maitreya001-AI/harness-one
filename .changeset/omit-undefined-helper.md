---
'harness-one': minor
---

Add `omitUndefined` helper to `harness-one/infra` to centralise the
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
