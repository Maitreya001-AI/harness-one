---
'harness-one': patch
---

Documentation + JSDoc improvements driven by FRICTION_LOG entries:

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
