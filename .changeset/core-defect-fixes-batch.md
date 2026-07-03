---
"harness-one": minor
---

Core defect fixes from the 2026-07 architecture review:

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
