# test-utils moved: `harness-one/advanced` → `harness-one/testing`

Source MIGRATION.md entry: *"`harness-one/testing` subpath added;
mock `AgentAdapter` factories moved off `harness-one/advanced`."*

## What changed

The mock adapter factories (`createMockAdapter`,
`createFailingAdapter`, `createStreamingMockAdapter`,
`createErrorStreamingMockAdapter`) plus the `MockAdapterConfig` type
no longer re-export from `harness-one/advanced`. They live behind
the new `harness-one/testing` subpath.

## Why

Shipping test doubles alongside production-extension primitives
(middleware, resilient-loop, fallback, output parsers) misled adapter
authors into wiring the mocks as a supported production fallback.
The rename is a routing change, not a signature change — the
factories themselves are byte-identical.

## Migration

```diff
-import { createMockAdapter } from 'harness-one/advanced';
+import { createMockAdapter } from 'harness-one/testing';
```

Shape unchanged.

## This fixture proves

- `pre/code.mjs` imports from `harness-one/advanced`. It MUST fail
  against the current build — otherwise the advanced surface still
  silently exposes the mocks and the migration prose is a lie.
- `post/code.mjs` imports from `harness-one/testing`. It MUST succeed —
  otherwise the new subpath doesn't actually export what we told
  users to migrate to.
