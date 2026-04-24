---
'@harness-one/ajv': patch
'@harness-one/preset': patch
'harness-one': patch
---

Chore: CI gate follow-ups after the TS6 / vitest 4 upgrade (PR #19). No runtime/API changes.

- `@harness-one/ajv` test suite now exercises the circular-schema stable-key fallback path, lifting branch coverage from 70.58% to 80.39% (over the 75% gate). Source unchanged.
- `@harness-one/preset`: two `@link` targets in the `createSecurePreset` TSDoc (`createDefaultLogger`, `registerProvider`) were demoted to inline code spans because they are not re-exported from the `harness-one` root bundle and so cannot be resolved by typedoc. Public API surface unchanged.
- `harness-one` (`observe/trace-manager`): one intra-doc `@link` demoted to a backtick reference for the same typedoc reason. Behaviour unchanged.

Tooling side (not versioned): `tools/check-pack-reproducible.mjs` now falls back to a content digest that alphabetises packed `package.json` dependency keys when raw tarball bytes differ, isolating a known pnpm `workspace:*` substitution quirk that previously flagged `@harness-one/preset` as non-reproducible every run. `docs-links.yml` bumped `actions/cache` v4.0.2 → v4.2.4 (deprecated-cache retirement). `secret-scan.yml` replaced the now-paywalled `gitleaks/gitleaks-action` with a direct CLI install from the upstream MIT-licensed release so the job runs without a per-org license.
