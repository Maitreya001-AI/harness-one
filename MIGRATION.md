# Migration Guide

This document tracks deprecations and removal schedules across the
`harness-one` monorepo. Every `@deprecated` symbol in the source tree
should have a row here; removal lands no earlier than the noted version.

Follow [SemVer](https://semver.org/): deprecated symbols continue to
work in every `0.x.y` release and are only removed in a major-version
bump. The "Removal target" column below is informational — we reserve
the right to extend deprecation windows when meaningful consumers are
still on the old API.

## Active deprecations

### Error codes

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `HarnessErrorCode.MEMORY_STORE_CORRUPTION` | `HarnessErrorCode.MEMORY_CORRUPT` | `v2.0` | Round-3 canonicalised on the `MEMORY_CORRUPT` name. Back-compat enum entry kept so existing `catch (e) { if (e.code === MEMORY_STORE_CORRUPTION) ... }` still matches. |
| `HarnessErrorCode.MEMORY_DATA_CORRUPTION` | `HarnessErrorCode.MEMORY_CORRUPT` | `v2.0` | Same as above — alternate spelling that some wave-12 callers relied on. |

### Error classes

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `GuardrailBlockedError` | `new HarnessError(reason, HarnessErrorCode.GUARD_VIOLATION, suggestion)` | `v2.0` | The runtime guardrail pipeline (`core/guardrail-runner.ts`) now throws the typed `HarnessError` form directly. `GuardrailBlockedError` is still exported for `instanceof` checks; new code should match on `err.code === HarnessErrorCode.GUARD_VIOLATION` instead. |

### Public barrels

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `createRedactor` from `harness-one/observe` | `harness-one/redact` | `v2.0` | Redaction primitives hoisted to a dedicated subpath. The `harness-one/observe` re-exports remain but are flagged `@deprecated`. |
| `redactValue` / `sanitizeAttributes` from `harness-one/observe` | `harness-one/redact` | `v2.0` | Same as above. |
| `REDACTED_VALUE` / `DEFAULT_SECRET_PATTERN` / `POLLUTING_KEYS` from `harness-one/observe` | `harness-one/redact` | `v2.0` | Same as above. |
| `type RedactConfig` / `type Redactor` from `harness-one/observe` | `harness-one/redact` | `v2.0` | Same as above. |

### Function signatures

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `createHandoff(orchestrator: AgentOrchestrator, ...)` overload | `createHandoff(transport: MessageTransport, ...)` | `v2.0` | `AgentOrchestrator` structurally satisfies `MessageTransport`, so no call-site changes are required — the type hint will simply prefer the more-specific overload going forward. |
| Flat `AgentLoopConfig` shape | Nested `AgentLoopConfigV2` (`{ limits, resilience, observability, pipelines, execution }`) | Not scheduled | Flat form remains fully supported. `createAgentLoop` accepts either shape; prefer the nested form in new code for ergonomic grouping. |

### Harness configuration

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| Passing both `adapter` and `client` on `HarnessConfig` | Pick one: `AdapterHarnessConfig` ({ adapter }) XOR `{Anthropic,OpenAI}HarnessConfig` ({ provider, client }) | `v2.0` (compile error today) | Wave-14 made the XOR a compile-time error via a discriminated union, plus a runtime guard with an explicit migration message. Consumers passing both were silently using the `adapter` branch before. |

### Cost tracker

| Symbol | Replacement | Removal target | Notes |
| --- | --- | --- | --- |
| `getCostByModel(): Record<string, number>` | `getCostByModelMap(): ReadonlyMap<string, number>` | Not scheduled | Both methods are supported. The Map variant supports O(1) membership tests and ordered iteration without the boxing overhead of `Object.entries()`. Prefer the Map view in new code. |

## Removed in prior waves

This section records historical deprecations that have already been
removed. It is not exhaustive — see `CHANGELOG.md` for the full
history. Only load-bearing renames that consumers might still need to
look up are captured here.

- (No prior removals yet — tracking begins in Wave-14.)

## How to file a deprecation

When flagging a new `@deprecated` symbol:

1. Add a `@deprecated` JSDoc tag with a one-sentence migration hint.
2. Add a row to the appropriate table in this file (Symbol,
   Replacement, Removal target, Notes).
3. If the removal is load-bearing, add a changeset under
   `.changeset/` so the deprecation appears in the next published
   changelog.
