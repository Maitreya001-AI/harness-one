# @harness-one/devkit

Developer-time toolkit for `harness-one`: evaluation runners, scorers, generator-evaluator pipelines, component registry, drift detection, and taste-coding utilities.

Eval + evolve dev-tooling ships from this sibling package — they are not subpaths of `harness-one`. The runtime architecture-checker stays in core under `harness-one/evolve-check`; everything dev-tool-shaped lives here.

## Install

```bash
pnpm add -D @harness-one/devkit
```

`harness-one` is declared as a peer dependency — devkit ships dev-time utilities; the consumer ships the runtime.

Node 18+.

## What's inside

### Eval

```ts
import {
  createEvalRunner,
  createGeneratorEvaluator,
  createBasicRelevanceScorer,
  createGroundednessScorer,
  createCoherenceScorer,
} from '@harness-one/devkit';
```

- **`createEvalRunner`** — runs a dataset through any harness-one `AgentLoop` / `createSecurePreset` instance and emits scored results.
- **`createGeneratorEvaluator`** — pairs a generator (the harness under test) with one or more scorer guardrails for offline benchmarks.
- **Scorers** — relevance, groundedness, coherence, and a small set of drop-in scorers for common evaluation rubrics.

### Evolve

```ts
import {
  createComponentRegistry,
  createDriftDetector,
  createTasteCoder,
} from '@harness-one/devkit';
```

- **`createComponentRegistry`** — long-lived registry of versioned components (prompts, tool definitions, guardrails) with rollback hooks.
- **`createDriftDetector`** — periodic comparison of live behavior vs a recorded baseline, emitting drift signals through the harness's `MetricsPort` / logger.
- **`createTasteCoder`** — lightweight A/B helper for prompt-engineering iterations during dev/staging.

### Architecture rules

The runtime architecture rule engine (`createArchitectureChecker`, `noCircularDepsRule`, `layerDependencyRule`, …) stays on the core's `harness-one/evolve-check` subpath because it gates production code.

## Imports

```ts
import { createEvalRunner } from '@harness-one/devkit';
import { createComponentRegistry, createDriftDetector } from '@harness-one/devkit';
import { createArchitectureChecker } from 'harness-one/evolve-check';
```

## Related

- [`harness-one`](../core) — runtime the devkit operates on.
- [`@harness-one/cli`](../cli) — `harness-one init --modules eval` scaffolds a starter project that imports devkit out of the box.
- Repository [`CHANGELOG.md`](../../CHANGELOG.md).
