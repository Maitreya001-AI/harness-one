---
'harness-one': minor
---

Add `defaultModelPricing` opt-in pricing snapshot and a construction-time
warning for the silent-`$0` failure mode.

**New exports** (from `harness-one/observe`):

- `defaultModelPricing` — frozen `readonly ModelPricing[]` snapshot
  covering Anthropic Claude 4.x / 3.x and OpenAI GPT-4o / 4 / 3.5 models.
  Includes Claude prompt-cache pricing (write = 1.25× input,
  read = 0.10× input).
- `DEFAULT_PRICING_SNAPSHOT_DATE` — ISO date of the snapshot, so callers
  can detect drift from current vendor pricing.
- `getDefaultPricing(model)` — lookup helper. Returns `undefined` for
  unknown models — callers must NOT treat that as a billing-safe `$0`.

**New behaviour**:

`createCostTracker({ budget, ... })` now emits a one-shot `safeWarn` when
a positive `budget` is supplied but the pricing table is empty. The
previous behaviour silently disabled the budget gate (every
`recordUsage()` returned `$0`, so the budget threshold was unreachable).

**Why**: see `apps/research-collab/HARNESS_LOG.md` entry L-006 — the
silent zero-cost mode broke production budget enforcement and made
test assertions degrade to `>= 0`.

`apps/research-collab/src/harness-factory.ts` is updated to pass
`pricing: [...defaultModelPricing]`, which makes the
`RESEARCH_BUDGET_USD` cap functional.
