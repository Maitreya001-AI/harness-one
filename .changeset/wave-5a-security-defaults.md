---
"harness-one": major
"@harness-one/preset": major
"@harness-one/anthropic": major
"@harness-one/openai": major
"@harness-one/langfuse": major
---

**Wave-5A — Security defaults flip (1.0-rc direction)**

Closes 6 P0 blockers from the 2026-04-14 adversarial architecture review
(`docs/forge-fix/wave-5/decisions.md`). This is a **breaking** release
targeting 1.0-rc quality. All defaults move from opt-in to fail-closed;
existing callers must adopt `createSecurePreset` or explicitly opt out.

**3,721 → 3,770 tests** (+49); typecheck + lint clean across 9 packages.

## Breaking changes

### SEC-A01 Redaction now default-on
- `createLogger()` redacts by default; pass `redact: false` to opt out
- `createTraceManager()` redacts span attributes / trace metadata / span
  events by default; pass `redact: false` to opt out
- `langfuseExporter.exportSpan` sanitizes by default; no "off" switch —
  pass a custom `sanitize` function to override

### SEC-A02 `LLMConfig.extra` allow-list
- Anthropic allow-list: `temperature, top_k, top_p, stop_sequences,
  thinking, metadata, system`
- OpenAI allow-list: `temperature, top_p, frequency_penalty,
  presence_penalty, stop, seed, response_format, user, service_tier,
  parallel_tool_calls`
- Unknown keys default: filtered + `safeWarn`
- Strict mode (`strictExtraAllowList: true`): throw
  `HarnessError('ADAPTER_INVALID_EXTRA')` before any network call

### SEC-A03 Tool registry production defaults
- `maxCallsPerTurn = 20` (was `Infinity`)
- `maxCallsPerSession = 100` (was `Infinity`)
- `timeoutMs = 30000` (was undefined)
- New `ToolCapability` taxonomy: `'readonly' | 'filesystem' | 'network'
  | 'shell' | 'destructive'`
- `createRegistry({ allowedCapabilities })` default `['readonly']`
- Tool `capabilities` not in allow-list → throw `TOOL_CAPABILITY_DENIED`
- Tool without `capabilities` → `safeWarn` (Wave-5C will upgrade to throw)
- `createPermissiveRegistry()` as opt-out escape hatch

### SEC-A04 AgentLoop guardrail pipeline hook points
- `AgentLoopConfig.inputPipeline?` and `outputPipeline?: GuardrailPipeline`
- Fixed hook order: `runInput` → tool execute → `runToolOutput` →
  next adapter turn → `runOutput`
- Hard-block: `abortController.abort('guardrail_violation')` closes
  streaming + emits `{ type: 'guardrail_blocked', phase, guardName }`
  event + `{ type: 'error' }` with code `GUARDRAIL_VIOLATION` + returns
- New error code `GUARDRAIL_VIOLATION` — `error-classifier` returns
  `retryable: false`, excluded from retry path
- No pipeline configured: AgentLoop instance `safeWarn` once

### SEC-A06 `sealProviders()` for `@harness-one/openai`
- New exports: `sealProviders()`, `isProvidersSealed()`
- `registerProvider()` after seal → throw `PROVIDER_REGISTRY_SEALED`
- `sealProviders()` is idempotent
- **No auto-seal in `createOpenAIAdapter`** (least-surprise)
- Per-module-instance singleton semantics; does not cross
  `worker_threads` or `vi.resetModules` boundaries

### New production entry: `createSecurePreset`
- `@harness-one/preset` exports `createSecurePreset(config)`
- Guardrail level presets: `'minimal' | 'standard' | 'strict'`
  (default `'standard'`)
- Default: injection + contentFilter + PII detector
- `skipProviderSeal` opt-out for rare re-register scenarios
- **No "guardrails off" escape hatch** — use `createHarness` if needed
- Idempotent across multiple calls in the same process

## Migration

### If you were using `createHarness`

```diff
- import { createHarness } from '@harness-one/preset';
+ import { createSecurePreset } from '@harness-one/preset';
- const harness = createHarness({ provider: 'anthropic', client, ... });
+ const harness = createSecurePreset({ provider: 'anthropic', client, ... });
```

This enables all Wave-5A defaults at once and is the recommended
production entry.

### If you need the old behavior

```ts
import { createHarness } from '@harness-one/preset';

const harness = createHarness({
  provider: 'anthropic',
  client,
  logger: createLogger({ redact: false }),           // if you really need raw logs
  guardrails: { /* explicit, not defaulted */ },
});
```

You must still work with new tool registry defaults (`allowedCapabilities:
['readonly']`). Either declare `capabilities` on every tool or use
`createPermissiveRegistry()`.

### Tool definitions

```diff
  defineTool({
    name: 'fetch_url',
    parameters: { /* ... */ },
+   capabilities: ['network'],
    execute: async ({ url }) => { /* ... */ },
  });
```

And if you register network/shell/fs tools, widen the registry:

```diff
- createRegistry({ validator });
+ createRegistry({ validator, allowedCapabilities: ['readonly', 'network'] });
```

### AgentLoop users

No change required — if you don't pass `inputPipeline` / `outputPipeline`,
you get a one-time `safeWarn` but behavior is unchanged. Use
`createSecurePreset` to automatically wire a guardrail pipeline.

## Tasks landed

- T01 `_internal/safe-log.ts` — `createDefaultLogger`, `safeWarn`, `safeError`
- T02 `createLogger` redaction default-on
- T03 `createTraceManager` redaction default-on
- T04 `langfuseExporter.exportSpan` sanitize default-on
- T05 Anthropic `extra` allow-list + strict mode
- T06 OpenAI `extra` allow-list + strict mode
- T07 Error codes `ADAPTER_INVALID_EXTRA`, `TOOL_CAPABILITY_DENIED`,
  `PROVIDER_REGISTRY_SEALED` registered
- T08 Tool registry production defaults (20/100/30s)
- T09 `ToolCapability` taxonomy + `allowedCapabilities` fail-closed
- T10 AgentLoop guardrail pipeline hook points
- T11 `sealProviders()` + `isProvidersSealed()` (idempotent, no auto-seal)
- T14 `createSecurePreset()` — fail-closed production entry
- T15 `docs/architecture/` sync
- T16 This changeset + CHANGELOG gate

Deferred (non-security cosmetic cleanup, scheduled for a follow-up):
- T12/T13 adapter `safeWarn` migration (M-9)

Full risk register + blocking conditions reviewed by `risk-assessor`:
see `docs/forge-fix/wave-5/wave-5a-plan.md` and
`docs/forge-fix/wave-5/wave-5a-checkpoint.md`.
