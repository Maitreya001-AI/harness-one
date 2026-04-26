---
'harness-one': minor
---

Add `HarnessConfigBase.tools` injection point — caller can either
inject a fully-built `ToolRegistry` or extend the secure default
`allowedCapabilities` whitelist.

**New shape**:

```ts
type HarnessConfigBase = {
  // ...existing fields
  readonly tools?:
    | { readonly registry: ToolRegistry; readonly allowedCapabilities?: never }
    | { readonly allowedCapabilities: readonly ToolCapabilityValue[]; readonly registry?: never };
};
```

The two fields are **mutually exclusive** — providing both raises
`CORE_INVALID_CONFIG` at construction time.

**Three modes** in `wireComponents`:

| `config.tools` | Behaviour |
|---|---|
| `{ registry }` | Use the caller's registry as-is (custom middleware, permission checker, byte caps, etc. preserved) |
| `{ allowedCapabilities }` | Build a registry with the explicit capability allow-list (e.g. `['readonly', 'network']` for apps that need web tools) |
| omitted | Build a registry with the secure default `allowedCapabilities: ['readonly']` (fail-closed) |

**Why**: previously `createHarness` / `createSecurePreset` hard-coded
`createRegistry({ validator })` and there was no way for downstream
apps to (a) inject a pre-configured registry, or (b) widen the
fail-closed capability whitelist without forking the preset. Apps
that legitimately needed network tools (`apps/research-collab`'s
`web_search` / `web_fetch`) had to under-declare their tools as
`Readonly` only — capability metadata fraud, exactly what the
whitelist mechanism exists to prevent (HARNESS_LOG L-001 / L-005).

**Migration**: `apps/research-collab/src/harness-factory.ts` now
passes `tools: { allowedCapabilities: ['readonly', 'network'] }` and
the web tools declare their truthful capability set.
