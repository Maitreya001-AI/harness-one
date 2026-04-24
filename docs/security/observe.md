# Observe · Threat Model

> Trace manager, cost tracker, logger, exporter coordinator, sampler,
> eviction. Carries every span/event that leaves the process toward
> OpenTelemetry / Langfuse / files — so disclosure is the dominant
> axis.

## Trust boundaries

- **Log/trace payloads** — mixed trust. Tool results, LLM outputs,
  error causes, user ids can land here.
- **Exporter adapters** — external systems. Send data over the network
  or to disk; once exported, we have no further control.
- **Sampler hook** — caller-supplied decision function.
- **Cost pricing table** — trusted (compiled in).

## STRIDE

### Spoofing

- **Threat**: A forged span id collides with an existing span,
  attributing events to the wrong trace.
  - Mitigation: Span/trace ids minted via `prefixedSecureId` backed by
    `crypto.randomBytes`; they're branded (`SpanId`, `TraceId`) at the
    type level to avoid accidental string substitution.
  - Evidence: `packages/core/src/infra/ids.ts`,
    `packages/core/src/infra/brands.ts`.

### Tampering

- **Threat**: An attacker who can inject attributes into a span (via a
  compromised tool) includes `__proto__` to pollute the exporter's
  serialiser output.
  - Mitigation: `sanitizeAttributes` walks every attribute and passes
    each key through the redactor; polluting keys in `POLLUTING_KEYS`
    (`__proto__`, `constructor`, `prototype`) are stripped.
  - Evidence: `packages/core/src/infra/redact.ts:23`,
    `packages/core/src/infra/redact.ts:111-125`,
    `packages/core/src/observe/trace-manager.ts:278`.

### Repudiation

- **Threat**: Evicted spans disappear silently; operators can't tell
  which ones were dropped under memory pressure.
  - Mitigation: Eviction tags the evicted span with
    `attributes['eviction.reason'] = 'trace_evicted'` before tear-down;
    caller-registered observers receive the evicted span ids from
    `evictIfNeeded()` and can log.
  - Evidence: `packages/core/src/observe/trace-eviction.ts:42`,
    `packages/core/src/observe/trace-eviction.ts:80-95`.

- **Threat**: Retry collector drops exporter-failed events.
  - Mitigation: `trace-retry-collector` buffers exporter failures and
    replays on the next flush; caller can observe drops via the
    collector's buffered-count API.
  - Evidence: `packages/core/src/observe/trace-retry-collector.ts`.

### Information Disclosure

- **Threat**: A user message containing a credit card or API key is
  attached to a span as attribute metadata and flows to an exporter.
  - Mitigation: TraceManager constructs a default redactor and runs
    `sanitizeAttributes` on every `metadata` input before the span is
    persisted. Default pattern covers api_key, authorization, token,
    password, cookie, session_id, etc.
  - Evidence: `packages/core/src/infra/redact.ts:19-21`,
    `packages/core/src/observe/trace-manager.ts:140`,
    `packages/core/src/observe/trace-manager.ts:278`.

- **Threat**: Error chain attached to a span carries the full request
  body / response content.
  - Mitigation: Logger flow runs `sanitizeAttributes` on merged
    metadata before `console`/exporter emission; `captureResponseBody`
    on adapter-caller is opt-in and callers pre-sanitise.
  - Evidence: `packages/core/src/infra/logger.ts:325-331`.

### Denial of Service

- **Threat**: Unbounded trace retention exhausts heap.
  - Mitigation: `TraceManager` enforces `maxTraces` hard cap (default
    in config); `evictIfNeeded` sweeps ended traces first, then LRU
    on running traces, and re-entrance is guarded so concurrent
    callers don't double-evict.
  - Evidence: `packages/core/src/observe/trace-eviction.ts:69-80`,
    `packages/core/src/observe/trace-eviction.ts:8-10`.

- **Threat**: A span accumulates unbounded events.
  - Mitigation: Spans cap their event list via TraceManager config;
    overflow events are dropped with a trace-level `truncated` flag.
  - Evidence: `packages/core/src/observe/trace-manager.ts`.

### Elevation of Privilege

- **Threat**: An exporter configured with network credentials logs
  them back to the console via its own error handler.
  - Mitigation: `createRedactor` is called by both Logger AND
    TraceManager so both surfaces filter the same default pattern;
    exporter adapters are expected to call `sanitizeAttributes` on any
    attributes they re-emit (OTel / Langfuse adapters both do).
  - Evidence: `packages/core/src/observe/trace-manager.ts:140`,
    `packages/core/src/infra/logger.ts:272`.

## Residual risks

- The default redaction pattern is **key-based**: if a secret is stored
  under a key the pattern doesn't recognise (e.g., `x_provider_api`),
  it flows through. Deployments must extend `extraPatterns` /
  `extraKeys` during init.
- Sampler decisions are opaque to the harness; a host-supplied sampler
  that drops 100% of traces effectively disables observability.
- Retry collector buffers failed exports in-memory; if the process
  dies before flush, those events are lost — acceptable for traces
  (best-effort) but not for audit logs. Callers needing durable audit
  should log to a WAL separately.
- Redactor is per-TraceManager; a trace built outside TraceManager and
  hand-exported skips sanitisation.

## References

- `docs/architecture/06-observe.md`
- `docs/adr/0005-trace-cost-token-unified.md`
- `docs/adr/0010-observe-port-vs-implementation.md`
- `packages/core/src/infra/redact.ts` — core redactor
