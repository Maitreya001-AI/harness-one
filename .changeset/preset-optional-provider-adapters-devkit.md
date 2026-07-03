---
"@harness-one/preset": major
---

Preset: provider adapters and the eval toolkit are now **optional peer
dependencies**, loaded lazily. Installing `@harness-one/preset` no longer drags
both provider adapters (plus their SDKs) or the dev-time eval tooling into your
production install/bundle.

**BREAKING — you must now install the adapter for your provider yourself.**
Previously `@harness-one/anthropic`, `@harness-one/openai`, and
`@harness-one/devkit` were direct `dependencies` auto-installed with the preset.
They are now `peerDependencies` with `peerDependenciesMeta.optional = true`.

What a consumer must install now:

- **Anthropic:** `npm install @harness-one/preset @harness-one/anthropic @anthropic-ai/sdk`
- **OpenAI:** `npm install @harness-one/preset @harness-one/openai openai`
- **Eval (`harness.eval`):** additionally `npm install @harness-one/devkit`

Injecting a pre-built `adapter` (the preferred `AdapterHarnessConfig` form) needs
neither provider package.

Behavior:

- `createHarness` / `createSecurePreset` remain **synchronous** — no public
  signature changed. The lazy load uses a `createRequire`-backed resolver that
  works in both the ESM and CJS builds, not an async `import()`.
- Only the **selected** provider's adapter is loaded. A `provider: 'anthropic'`
  harness never loads `@harness-one/openai` (or the `openai` SDK it
  value-imports), and vice-versa. This also removes a latent crash where module
  load could throw when the *unused* provider's peer SDK was absent.
- Selecting a provider whose package is not installed throws an actionable
  `HarnessError` naming the exact `npm install` command.
- `harness.eval` loads `@harness-one/devkit` lazily on first use. If devkit is
  absent, constructing the harness still succeeds (graceful degradation); the
  actionable `HarnessError` is thrown only when an `eval` method is actually
  invoked.
- `createSecurePreset` seals the OpenAI provider registry only when
  `@harness-one/openai` is present; an Anthropic-only (or injected-adapter)
  deployment degrades gracefully with nothing to seal.

Migration: add the provider adapter package + its SDK (and `@harness-one/devkit`
if you use `harness.eval`) to your own `dependencies`. No application code
changes are required.
