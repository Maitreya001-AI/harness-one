---
'harness-one': minor
---

`createStreamingMockAdapter` now enforces a usage-propagation contract:

- **Auto-attaches `config.usage`** to terminal `done` chunks the caller
  passed *without* a `usage` field (non-destructive — chunks that
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
