---
'harness-one': patch
---

Cross-subpath ergonomic re-exports — zero runtime cost, type-only:

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
