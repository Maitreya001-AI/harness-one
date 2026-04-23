# @harness-one/devkit

Developer-time toolkit for `harness-one`: evaluation runners, starter scorers,
generator-evaluator loops, data-flywheel helpers, component registry, drift
detection, and taste-coding utilities.

Eval + evolve tooling ships from this sibling package rather than a core
subpath. The runtime architecture-checker stays in core under
`harness-one/evolve-check`; everything dev-tool-shaped lives here.

## Install

```bash
pnpm add -D @harness-one/devkit
```

`harness-one` is a peer dependency. Node 18+.

## Eval

```ts
import {
  createEvalRunner,
  createBasicRelevanceScorer,
  createBasicFaithfulnessScorer,
  createBasicLengthScorer,
  createCustomScorer,
  runGeneratorEvaluator,
  extractNewCases,
} from '@harness-one/devkit';
```

- **`createEvalRunner`** runs datasets through scorer pipelines and produces reports.
- **`createBasicRelevanceScorer` / `createBasicFaithfulnessScorer` / `createBasicLengthScorer`** are baseline starter scorers, not production-optimal judges.
- **`createCustomScorer`** lets you plug in domain-specific or LLM-as-judge scoring.
- **`runGeneratorEvaluator`** implements the generate → evaluate → feedback → retry loop.
- **`extractNewCases`** turns low-scoring results into new regression cases for a data flywheel.

## Evolve

```ts
import {
  createComponentRegistry,
  createDriftDetector,
  createTasteCodingRegistry,
} from '@harness-one/devkit';
```

- **`createComponentRegistry`** tracks versioned prompts, tool definitions, guardrails, and retirement conditions.
- **`createDriftDetector`** compares live signals against a stored baseline and reports drift severity.
- **`createTasteCodingRegistry`** stores postmortem-derived engineering rules and can export them as Markdown.

## Architecture Rules

The runtime architecture rule engine lives on the core subpath:

```ts
import { createArchitectureChecker } from 'harness-one/evolve-check';
```

That split is intentional: architecture rules can gate production code, while
devkit stays purely developer-time.

## Related

- [`harness-one`](../core) is the runtime this package evaluates and evolves.
- [`@harness-one/cli`](../cli) can scaffold starter projects that already import devkit.
- Root migration notes live in [MIGRATION.md](../../MIGRATION.md).
