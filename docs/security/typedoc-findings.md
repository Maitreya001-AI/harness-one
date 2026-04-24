# typedoc gate — baseline findings (April 2026)

The CI gate `pnpm docs:api` runs `typedoc` with
`treatValidationWarningsAsErrors: true`, so any invalid `{@link}` target
or not-exported reference in a public-API doc comment fails CI.

Wiring the gate (track-M) surfaced the following pre-existing findings.
Per track-M discipline, source code is not modified in this PR; the
findings are recorded here so maintainers can file/fix them separately.

Each bullet is an independently filable issue. Package names are from
the respective `packages/<name>/src/*` entry point.

## Invalid `{@link}` targets in public-API doc comments

- `@harness-one/preset` — `createHarness` comment links to `buildHarness` (symbol does not exist).
- `@harness-one/redis` — `RedisMemoryStore` comment links to `MemoryStore` (not exported from this package).
- `harness-one` — `HarnessErrorCode` comment links to `createCustomErrorCode`.
- `harness-one` — `createTraceManager.config.redactor` comment links to `Redactor` (exported but not resolvable at this site).
- `harness-one` — `createCostTracker` comment links to `OVERFLOW_BUCKET_KEY`.
- `harness-one` — `SystemMessage` comment links to `createTrustedSystemMessage`.
- `harness-one` — `TrustedSystemBrand` comment links to `HOST_SECRET`.
- `harness-one` — `TrustedSystemBrand` comment links to `createTrustedSystemMessage`.
- `harness-one` — `HarnessErrorDetails` comment links to `createCustomErrorCode`.
- `harness-one` — `ToolCall.arguments` comment links to `ParsedToolArgumentsMeta`.
- `@harness-one/preset` — `AnthropicHarnessConfig` comment links to `AdapterHarnessConfig`.
- `@harness-one/preset` — `OpenAIHarnessConfig` comment links to `AdapterHarnessConfig`.
- `@harness-one/preset` — `HarnessConfig` comment links to `AdapterHarnessConfig`.
- `@harness-one/preset` — `validateHarnessRuntimeConfig` comment links to `readNumber`.
- `@harness-one/anthropic` — `AnthropicAdapterConfig.streamLimits` comment links to `StreamAggregator`.

Each is either (a) a symbol renamed without updating the `{@link}`, or
(b) a symbol that exists but is not reachable from the site's package
scope. Remediation is a single-line doc-comment edit per finding.

## Resolution policy

Until these are addressed, the `docs-api` job is expected to be red on
main. Maintainers can either:

1. **Pay down the debt first** — open a mechanical follow-up PR that fixes
   all 16 `{@link}` targets (comment-only changes; no behavioural risk).
2. **Land track-M now and fix incrementally** — add `docs-api` as a
   *non-required* check until the debt is cleared, then promote it to
   required.

Either option is consistent with the gate's intent: new regressions will
fail CI starting from whatever baseline maintainers adopt.
