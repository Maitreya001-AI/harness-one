---
'harness-one': minor
---

Guardrail type-and-runtime tightening pass — closes three friction
entries at once:

**1. `createPipeline` runtime entry validation** (HARNESS_LOG HC-003)

Pipeline entries are runtime-validated at construction time. Bare
`Guardrail` functions or `[g as never]`-style bypasses now throw
`HarnessError(GUARD_INVALID_PIPELINE)` immediately instead of leading
to silent `passed: false` runtime failures. The previous shape
silently typechecked when `as never` was used and produced opaque
fail-closed verdicts at every call.

**2. `GuardrailContext.direction` + `source` first-class fields**
(research-collab L-002)

`GuardrailContext` gains two top-level fields:

- `direction?: 'input' | 'output' | 'tool_output' | 'rag'` — auto-filled
  by the pipeline before each guardrail runs, based on which `run*`
  method was called. Caller-supplied direction wins.
- `source?: string` — free-form provenance tag (URL, file, tool name).

Trace exporters and observability tooling no longer have to dig into
`meta` for these standard fields.

**3. `SyncGuardrail` / `AsyncGuardrail` narrow aliases**
(research-collab L-003)

`harness-one/guardrails` now exports two narrower aliases alongside
the existing `Guardrail` union:

- `SyncGuardrail = (ctx) => GuardrailVerdict`
- `AsyncGuardrail = (ctx) => Promise<GuardrailVerdict>`

Built-in synchronous guardrails (e.g. `createInjectionDetector`) can
declare their return type as `SyncGuardrail` so callers don't need
the `instanceof Promise` defensive narrowing. The pipeline still
accepts the union.

**Bonus: `getRejectionReason(result)` helper** (showcase 02)

New utility exported from `harness-one/guardrails`:

```ts
function getRejectionReason(result: PipelineResult): string | undefined;
```

Returns the verdict's `reason` for `block`/`modify` verdicts,
`undefined` otherwise. Replaces the verbose
`'reason' in verdict.verdict ? verdict.verdict.reason : 'policy violation'`
narrowing dance every consumer previously had to write.

**Migration**: callers using `createInjectionDetector()` directly as
the `guard:` field of a pipeline entry must now use
`createInjectionDetector().guard` (the function), not the whole
`{ name, guard }` object — the prior shape silently degraded into a
fail-closed pipeline. The new validation surfaces the misuse loudly.
