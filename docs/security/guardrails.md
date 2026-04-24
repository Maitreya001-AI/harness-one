# Guardrails · Threat Model

> Fail-closed pipeline orchestrating input/output/tool-output/RAG guards
> + built-ins (injection detector, PII detector, content filter,
> schema validator, rate limiter). The last line of defence before
> untrusted content reaches the LLM or the user.

## Trust boundaries

- **Guard implementations** — partially trusted. Built-in guards are
  audited; caller-supplied guards can throw or hang.
- **Guardrail context** — untrusted content being evaluated.
- **Pipeline port** — opaque; `assertPipeline` defends against forged
  tokens.
- **Regex patterns** — caller-supplied `extraPatterns` are validated
  for ReDoS at construction time.

## STRIDE

### Spoofing

- **Threat**: A forged `GuardrailPipeline` passed to the module-level
  wrappers (`runInput`, `runOutput`, `runToolOutput`, `runRagContext`)
  skips real evaluation.
  - Mitigation: `assertPipeline` verifies the pipeline exposes the
    port methods before delegating; forged `{}` tokens throw
    `GUARD_INVALID_PIPELINE`.
  - Evidence: `packages/core/src/guardrails/pipeline.ts:19-30`.

### Tampering

- **Threat**: Content normalisation fails on a lone high surrogate,
  causing `normalize('NFKC')` to throw and the pipeline to short-circuit
  without running downstream guards.
  - Mitigation: Per ADR-0006, pipeline runs fail-closed by default —
    any thrown guard results in `passed: false`. The O2 fuzz (2000
    runs) asserts arbitrary unicode never throws past the pipeline.
  - Evidence: `packages/core/src/guardrails/pipeline.ts:99` (failClosed
    default), `packages/core/tests/fuzz/guardrail-input.fuzz.test.ts`.

- **Threat**: An injection detector ReDoS pattern tampers with
  subsequent calls by overshooting the event loop.
  - Mitigation: `isReDoSCandidate` rejects caller-supplied patterns
    with nested or adjacent quantifiers at construction; `maxLength`
    caps on content before regex (100 KB prefix + suffix samples for
    megabyte inputs).
  - Evidence: `packages/core/src/guardrails/content-filter.ts:30`,
    `packages/core/src/guardrails/injection-detector.ts:145-152`,
    `packages/core/src/guardrails/injection-detector.ts:207-213`.

### Repudiation

- **Threat**: A guardrail blocks content silently, leaving no telemetry
  record of why.
  - Mitigation: Every guard run emits a `GuardrailEvent` (guard name,
    verdict, latency) into `PipelineResult.results`; callers can
    subscribe via `onEvent`.
  - Evidence: `packages/core/src/guardrails/pipeline.ts:100`.

### Information Disclosure

- **Threat**: Schema validator error messages leak internal field
  names / schema structure to a user-facing error.
  - Mitigation: `redactErrors: true` (default) rewrites path segments
    past the root to `[REDACTED]` and strips property-name fragments
    from the message before returning it.
  - Evidence: `packages/core/src/guardrails/schema-validator.ts:78`,
    `packages/core/src/guardrails/schema-validator.ts:108-116`.

- **Threat**: PII detector's "detect" message echoes the match back to
  the caller, leaking the PII value.
  - Mitigation: Detector returns `reason: 'PII detected: <type>'` — the
    category label only, not the match. Match details stay internal.
  - Evidence: `packages/core/src/guardrails/pii-detector.ts`.

### Denial of Service

- **Threat**: A single guard hangs forever.
  - Mitigation: Default `defaultTimeoutMs: 5000` applied to every guard
    entry that doesn't specify its own; pipeline-wide
    `totalTimeoutMs: 30000` cap.
  - Evidence: `packages/core/src/guardrails/pipeline.ts:83-99`.

- **Threat**: 10 MB input hits every guard sequentially, exhausting
  time budget.
  - Mitigation: Schema validator blocks inputs over `maxJsonBytes`
    (1 MiB default) before parsing; injection detector limits regex
    scan to 100 KB prefix/suffix samples; pipeline's
    `totalTimeoutMs` caps the worst-case walk. Exercised by O2 fuzz
    "10 MB payload is rejected, not panicked".
  - Evidence: `packages/core/src/guardrails/schema-validator.ts:79-95`,
    `packages/core/src/guardrails/injection-detector.ts:169`.

- **Threat**: `maxResults` grows without bound, eating memory.
  - Mitigation: Cap `1000` events per pipeline run; oldest non-block
    events evicted first.
  - Evidence: `packages/core/src/guardrails/pipeline.ts:101`,
    `packages/core/src/guardrails/pipeline.ts:156-176`.

### Elevation of Privilege

- **Threat**: A `modify` verdict rewrites the content bypassing a
  downstream `block` verdict — content that would have been blocked
  survives because the block guard only saw the modified text.
  - Mitigation: Pipeline runs guards in the configured order; modify
    rewrites threaded forward, so every downstream guard sees the
    rewritten content and can still reject.
  - Evidence: `packages/core/src/guardrails/pipeline.ts:331-343`.

- **Threat**: `withGuardrailRetry` regenerates content until a guard
  passes, burning tokens indefinitely if the LLM can't satisfy the
  guard.
  - Mitigation: Configurable `maxRetries` with a terminal "exhausted"
    HarnessError; each regenerate is wrapped in its own
    `regenerateTimeoutMs`.
  - Evidence: `packages/core/src/guardrails/self-healing.ts:66`,
    `packages/core/src/core/output-parser.ts:187-210` (similar pattern).

## Residual risks

- Fail-closed is the default but can be disabled with `failClosed:
  false`. Deployments that do so accept the trade-off that a throwing
  guard allows content through.
- Injection detector is pattern-based and covers common pirate-pattern
  injections; novel attacks that don't match any base pattern pass.
  Callers expecting higher recall should chain a model-based detector.
- Rate limiter is per-pipeline instance; horizontally-scaled
  deployments must share state via `@harness-one/redis` or similar.

## References

- `docs/architecture/05-guardrails.md`
- `docs/adr/0006-fail-closed-guardrail-default.md`
- `packages/core/tests/fuzz/guardrail-input.fuzz.test.ts` — O2 coverage
