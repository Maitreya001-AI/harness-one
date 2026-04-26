# `harness-one-coding`

Autonomous coding agent built on `harness-one`. Long-horizon dogfood + reusable vertical package.

> See [`docs/coding-agent-DESIGN.md`](../../docs/coding-agent-DESIGN.md) for the design spec, and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the staged build progress. Frictions encountered against `harness-one` are recorded in [`HARNESS_LOG.md`](./HARNESS_LOG.md) per the project's reuse-back contract.

## Status

MVP plumbing complete (S1 – S9). Production hardening, broader e2e coverage, and the npm-publish path are tracked in `IMPLEMENTATION_PLAN.md`.

## What's in the box

- **`createCodingAgent`** factory wiring all seven MVP tools, dual guardrail pipelines, soft-guardrail auditor (approval flow), checkpoint manager, three-dimensional budget tracker, and JSONL trace exporter.
- **`harness-coding` CLI** (`src/cli/bin.ts`) with the full DESIGN §4.2 flag surface, SIGINT/SIGTERM graceful-abort, plus a `harness-coding ls` sub-command that lists checkpoints from the on-disk store.
- **State machine** — `planning → executing → testing → reviewing → done` with `aborted` reachable from any non-terminal state. Every transition writes a checkpoint.

## Install

```bash
pnpm i harness-one-coding
# peer deps (resolve as you wish)
pnpm i @anthropic-ai/sdk @harness-one/anthropic harness-one
```

## CLI usage

```bash
# fresh task
harness-coding "Fix the failing test in src/utils/parse.ts"

# constrain budgets
harness-coding --max-tokens 100000 --max-iterations 50 --max-duration 15m \
               --approval auto \
               "Refactor the auth module"

# plan only — never executes a tool
harness-coding --plan-only "Decompose the migration into steps"

# dry run — write_file / shell refuse to mutate state
harness-coding --dry-run "Try a fix to parse.ts"

# resume from a checkpoint
harness-coding --resume task_1714153200000_abc123def456

# list checkpoints
harness-coding ls
```

Exit codes:

| Code | Meaning |
|---|---|
| 0   | task completed |
| 1   | uncaught error |
| 64  | EX_USAGE — bad flag |
| 75  | EX_TEMPFAIL — budget exhausted |
| 130 | aborted via SIGINT |

## Programmatic API

```ts
import { createCodingAgent } from 'harness-one-coding';
import { createAnthropicAdapter } from '@harness-one/anthropic';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const adapter = createAnthropicAdapter({
  client: anthropic,
  model: 'claude-sonnet-4-20250514',
});

const agent = await createCodingAgent({
  adapter,
  workspace: process.cwd(),
  approval: 'allowlist',
  autoAllow: { autoAllowCommands: ['pnpm'] },
  budget: { tokens: 200_000, iterations: 100, durationMs: 30 * 60_000 },
});

const result = await agent.runTask({
  prompt: 'Fix the failing test in src/utils/parse.ts',
});
console.log(result.summary);
console.log(result.changedFiles);
console.log(`cost: $${result.cost.usd.toFixed(4)} (${result.cost.tokens} tokens)`);
await agent.shutdown();
```

## Configuration knobs

| Option | Description |
|---|---|
| `workspace` | Workspace root (canonicalised via `realpath`). Default: `process.cwd()`. |
| `model` | Threaded through the adapter and the cost tracker. |
| `budget.tokens` / `.iterations` / `.durationMs` | Three-dim budget; any exhausted axis triggers a graceful abort + checkpoint. |
| `approval` | `auto` / `always-ask` (default) / `allowlist`. |
| `autoAllow.autoAllowCommands` | Shell command names to auto-approve under `allowlist` mode. |
| `shellAllowlist` | Override the static command allowlist (defaults to `pnpm`/`npm`/`yarn`/`node`/`tsc`/`tsx`/`vitest`/`eslint`/`prettier`/`pytest`/`python`/`python3`/`git`). |
| `checkpointDir` | On-disk checkpoint root. Default: `~/.harness-coding/checkpoints`. |
| `checkpointStore` | Inject a custom `MemoryStore`. |
| `traceExporters` / `traceDir` | Override the JSONL trace exporter. Default: `~/.harness-coding/traces`. Pass `[]` to disable. |
| `pricing` | `ModelPricing[]` for accurate cost estimates. |
| `dryRun` | When `true`, fs/shell tools refuse to mutate state. |

## Tool surface (MVP)

| Tool | Capability | Bounded by |
|---|---|---|
| `read_file` | filesystem (R) | `maxBytes` (≤ 256 KB), workspace containment, sensitive-path block |
| `write_file` | filesystem (RW) | atomic temp+rename, large-diff approval gate (>100 lines), dry-run |
| `list_dir`  | filesystem (R) | entry limit (default 200, max 1000) |
| `grep`      | filesystem (R) | result limit, max-files-scanned, skip `node_modules`/`.git`/`dist` etc., regex pattern length |
| `shell`     | shell | argv-only (no shell interpolation), allowlist + deny patterns, timeout, env-var redaction |
| `run_tests` | shell | runner auto-detect (pnpm/npm/yarn/pytest), 5-min default timeout |
| `git_status` | shell (R) | porcelain v1 parser |

## Guardrails

- **Hard** (cannot be disabled): workspace path containment, sensitive filename blocklist, command deny-pattern + hard-deny lists, env-var scrub before `spawn`.
- **Soft** (auditor): every shell call + every >100-line write goes through `auditor.decide()`. Modes: `auto` / `always-ask` (TTY) / `allowlist` (fingerprint or command name). Non-TTY stdin fails closed by default.

## Reuse-back

When you hit ergonomic friction with `harness-one` while building this app, log it in [`HARNESS_LOG.md`](./HARNESS_LOG.md) with severity, repro, workaround, and requested fix. Quarterly RETROs aggregate these into reuse-back proposals (`RETRO/`).
