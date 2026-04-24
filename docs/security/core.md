# Core · Threat Model

> AgentLoop + shared types + error taxonomy. This subsystem owns the
> run-loop lifecycle, the adapter interface, and the streaming budget
> enforcement. It is the primary blast-radius for any attack that
> reaches the harness — everything else is called *from* core.

## Trust boundaries

- **User input** (`conversation: Message[]` passed to `run()`) —
  untrusted. May carry attacker-controlled system-role claims, prompt
  injection, or byte-level malformed content.
- **Adapter I/O** (`AgentAdapter.chat|stream`) — semi-trusted. Provider
  SDKs are audited; network output is not. Stream chunks arrive chunked
  and interleaved with tool calls.
- **Tool output** — untrusted. Tools can be third-party code running in
  the same process; their return values flow back into the conversation.
- **External AbortSignal** — trusted (caller-owned) but its failure
  modes (never fires, fires too eagerly) must not crash the loop.

## STRIDE

### Spoofing

- **Threat**: An attacker who can write to the conversation store
  persists a message with `role: 'system'` to elevate their next turn
  into a trusted system prompt.
  - Mitigation: System messages carry a process-local `Symbol` brand
    (`TRUSTED_SYSTEM_BRAND`) that never serialises; messages restored
    without the brand are downgraded to `role: 'user'`.
  - Evidence: `packages/core/src/core/trusted-system-message.ts:24`,
    `packages/core/src/core/trusted-system-message.ts:62`.

- **Threat**: Forged `GuardrailPipeline` instance smuggled into the loop
  via `{} as GuardrailPipeline`.
  - Mitigation: `assertPipeline()` rejects any object missing the port
    methods before runInput/runOutput is called.
  - Evidence: `packages/core/src/guardrails/pipeline.ts:20`.

### Tampering

- **Threat**: Stream chunk claims arbitrary `type` to poison the
  accumulator (`tool_call_delta` without id attaches to the wrong tool).
  - Mitigation: `StreamAggregator.handleChunk` emits a `warning` event
    and falls through rather than throwing when a delta arrives without
    any accumulated tool call.
  - Evidence: `packages/core/src/core/stream-aggregator.ts:411`.

- **Threat**: Tool arguments contain a UTF-8 byte bomb that explodes
  after accumulation and passes the per-chunk cap but breaks cumulative
  budgets.
  - Mitigation: `maxCumulativeStreamBytes = maxIterations × maxStreamBytes`
    is enforced inside the aggregator on every delta.
  - Evidence: `packages/core/src/core/agent-loop.ts:150-154`,
    `packages/core/src/core/stream-aggregator.ts:282-286`.

### Repudiation

- **Threat**: A run that errors mid-iteration leaves no telemetry record
  of what it did before failing.
  - Mitigation: `iteration-lifecycle` closes spans via `bailOn*`
    helpers that fire `onIterationEnd` + error-span attributes regardless
    of the termination path.
  - Evidence: `packages/core/src/core/iteration-lifecycle.ts`,
    `packages/core/src/core/error-span-attributes.ts`.

### Information Disclosure

- **Threat**: Secrets bleed into logs / trace attributes (API keys,
  bearer tokens, cookies, session ids).
  - Mitigation: Default `createRedactor` pattern matches `api_key`,
    `authorization`, `secret`, `token`, `cookie`, `session_id`, etc.;
    `sanitizeAttributes` walks trace metadata before export.
  - Evidence: `packages/core/src/infra/redact.ts:19-23`,
    `packages/core/src/infra/logger.ts:330`.

- **Threat**: An error cause chain carries the full raw request body
  into `HarnessError.details` and propagates to the console.
  - Mitigation: `HarnessError` captures `cause` but the default Logger
    runs `sanitizeAttributes` over merged metadata before emission; body
    capture is opt-in via `captureResponseBody` on the adapter caller.
  - Evidence: `packages/core/src/infra/logger.ts:325-331`,
    `packages/core/src/core/errors.ts`.

### Denial of Service

- **Threat**: Adversarial model output streams unbounded text to exhaust
  memory.
  - Mitigation: `MAX_STREAM_BYTES` (10 MiB default) per iteration +
    `maxIterations × maxStreamBytes` across the run; violations surface
    as `ADAPTER_PAYLOAD_OVERSIZED`.
  - Evidence: `packages/core/src/core/agent-loop-config.ts:34`,
    `packages/core/src/core/stream-aggregator.ts:282-286`.

- **Threat**: Model emits thousands of tool calls with arbitrary ids to
  inflate the `accumulatedToolCalls` Map.
  - Mitigation: `MAX_TOOL_CALLS = 128` enforced before allocating a new
    entry; over-budget deltas emit a terminal `error` event.
  - Evidence: `packages/core/src/core/agent-loop-config.ts:43`,
    `packages/core/src/core/stream-aggregator.ts:354-369`.

- **Threat**: Adapter hangs mid-call; the AgentLoop has no external
  abort and cannot recover.
  - Mitigation: `adapter-timeout.ts` wraps every `adapter.chat/stream`
    call in a managed `AbortController` tied to the caller's `signal`
    and the configured per-call deadline.
  - Evidence: `packages/core/src/core/adapter-timeout.ts`,
    `packages/core/src/core/agent-loop.ts:137-147`.

### Elevation of Privilege

- **Threat**: A tool-call payload contains
  `{"__proto__":{"admin":true}}` and the registry's eventual consumer
  reads from `Object.prototype`.
  - Mitigation: `JSON.parse` itself drops own-property `__proto__`
    semantics; the redactor's `POLLUTING_KEYS` set explicitly bars
    `__proto__`, `constructor`, and `prototype` from sanitised metadata.
  - Evidence: `packages/core/src/infra/redact.ts:23`,
    `packages/core/src/infra/redact.ts:71`.

- **Threat**: An in-process tool triggers a throw that isn't caught,
  aborting the loop and potentially leaving other tools mid-execution.
  - Mitigation: `iteration-runner` wraps `tool.execute` in a registry
    boundary that converts throws into `toolError` replies; the
    `bailOut` discriminated union funnels every termination path
    through the same finalizer.
  - Evidence: `packages/core/src/tools/registry.ts:407-485`,
    `packages/core/src/core/iteration-runner.ts`.

## Residual risks

- Tools **inside** the process remain a sovereign boundary: the harness
  cannot prevent a compromised tool module from monkey-patching globals
  or reading env vars. Deployments expecting strong isolation should
  run the harness in a restricted Node VM or container per request.
- AgentLoop trusts its configured `AgentAdapter` implementation.
  Adapters are expected to validate provider responses themselves
  (ADR-0008 — conformance testing, not mocks).
- `HarnessError.details` is caller-supplied; if a caller shoves raw
  request/response bodies into `details`, redaction cannot reach them
  before the Logger's `sanitizeAttributes` sees the flattened shape.
  Callers must pre-sanitise before throwing.

## References

- `docs/architecture/01-core.md`
- `docs/adr/0007-trusted-system-message-brand.md`
- `docs/adr/0009-streaming-hard-limits.md`
- `tests/fuzz/tool-args-parser.fuzz.test.ts` — O1 coverage
- `tests/fuzz/sse-stream-parser.fuzz.test.ts` — O3 coverage
