# typedoc gate — findings resolution log

The CI gate `pnpm docs:api` runs `typedoc` with
`treatValidationWarningsAsErrors: true`, so any invalid `{@link}` target
or not-exported reference in a public-API doc comment fails CI.

## Initial baseline (April 2026)

Wiring the gate surfaced 15 pre-existing invalid `{@link}` targets in
public-API doc comments. All were resolved in this PR by one of:

- Converting `{@link X}` to `` `X` `` (backticks) when `X` is an
  internal symbol that should not render as a doc link.
- Leaving the `{@link X}` alone when `X` is a visible public symbol
  (the resolution path was healthy, just rendering-order-sensitive).

Files touched (all comment-only edits):

- `packages/preset/src/index.ts` — `buildHarness` reference.
- `packages/redis/src/index.ts` — cross-package `MemoryStore` reference.
- `packages/core/src/infra/errors-base.ts` — `createCustomErrorCode` references.
- `packages/core/src/core/types.ts` — `createTrustedSystemMessage`, `HOST_SECRET` references.
- `packages/core/src/observe/trace-manager.ts` — `Redactor` reference.
- `packages/core/src/observe/cost-tracker.ts` — `OVERFLOW_BUCKET_KEY` reference.
- `packages/core/src/observe/cost-tracker-eviction.ts` — `OVERFLOW_BUCKET_KEY` references.
- `packages/core/src/tools/types.ts` — `ParsedToolArgumentsMeta` reference.
- `packages/preset/src/build-harness/types.ts` — `AdapterHarnessConfig` references.
- `packages/preset/src/validate-config.ts` — `readNumber` reference.
- `packages/anthropic/src/adapter.ts` — `StreamAggregator` reference.

Running `pnpm docs:api` against the current tree exits 0 with no
validation warnings. Any new invalid `{@link}` from future PRs will
fail the gate.

## Going forward

When adding a new `{@link X}`:

- If `X` is exported from one of the packages listed in
  `typedoc.json`'s `entryPoints`, the link resolves.
- If `X` is internal or exported from a different package (cross-package
  linking is not configured), use `` `X` `` backticks instead.
- If `X` does not exist, the gate will fail — fix the reference before
  merging.
