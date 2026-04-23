# @harness-one/cli

CLI scaffolding + usage-audit tool for `harness-one`. Exposes the `harness-one` binary used to bootstrap new projects and print objective module-usage stats for existing ones.

The CLI ships as a standalone sibling package. Use `pnpm dlx @harness-one/cli ...` or install locally.

## Install

```bash
# One-shot use without installing:
pnpm dlx @harness-one/cli init --modules core,tools,guardrails

# Or as a local dev dependency:
pnpm add -D @harness-one/cli
```

Node 18+. Depends on `harness-one` (regular dependency; not peer) so the CLI resolves cleanly from a fresh `node_modules`.

## Commands

- **`harness-one init [--modules ...]`** — scaffold a starter project that imports the requested module surfaces. Templates emit modern subpath imports (e.g. `from 'harness-one/tools'`, `from '@harness-one/devkit'`). The `--modules eval`/`--modules evolve` flags now route to `@harness-one/devkit`; the architecture-checker stays on `harness-one/evolve-check`.
- **`harness-one audit`** — scan a project directory for `harness-one/*` imports and print per-module import-site counts plus used/unused coverage.
- **`harness-one help [<topic>]`** — interactive module documentation browser. No network calls; everything ships with the binary.

## Programmatic API

The package also exports the parser + template registry for tools that want to embed the same scaffolding logic without shelling out to `harness-one init`.

```ts
import { parseInitArgs, renderTemplates } from '@harness-one/cli';
```

## Related

- [`harness-one`](../core) — the core runtime the CLI scaffolds against.
- [`@harness-one/devkit`](../devkit) — eval + evolve dev-tools the templates link to.
- Repository [`README.md`](../../README.md) / [`CHANGELOG.md`](../../CHANGELOG.md).
