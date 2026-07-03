---
"harness-one": patch
---

Re-introduce runtime-working `@deprecated` aliases for symbols renamed during
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
