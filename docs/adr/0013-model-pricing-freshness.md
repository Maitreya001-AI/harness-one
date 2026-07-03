# ADR-0013 · Treat `defaultModelPricing` as a dated snapshot, not a live source of truth

- **Status**: Accepted
- **Date**: 2026-07-03
- **Deciders**: harness-one maintainers

## Context

Cost tracking needs per-model prices. `harness-one/observe` ships
`defaultModelPricing` — an opt-in table of public per-1k-token prices for
the major Claude and GPT models — so a user can wire budget gating without
hand-authoring a pricing map (this closed the cross-app "silent $0" friction:
research-collab L-2026-04-26-006, showcase-01).

Prices are external, mutable data. Vendors re-price models, add tiers, and
retire SKUs on their own schedule. A hard-coded table is correct only as of
the day it was written, and a *silently* stale table is worse than no table:
budget gates compute confidently wrong numbers instead of loudly refusing.

The tension: core promises **zero runtime dependencies**
([ADR-0004](./0004-zero-runtime-deps-in-core.md)) and deterministic behavior
(so tests, cassettes, and cost assertions are reproducible). A "just fetch
current prices" solution would violate both — it adds an HTTP client and
makes cost output depend on wall-clock network state.

## Decision

> **`defaultModelPricing` is an explicitly dated *snapshot*, not a live
> lookup. The table carries a `DEFAULT_PRICING_SNAPSHOT_DATE` marker; the
> release checklist re-verifies the numbers and bumps that date every
> release; and `warnUnpricedModels` (default-on) is the runtime guard for
> models the snapshot doesn't cover. Live/network pricing lookup is
> rejected.**

The freshness policy has three legs:

1. **Dated snapshot.** `default-pricing.ts` exports
   `DEFAULT_PRICING_SNAPSHOT_DATE` and documents, in-file, that vendor
   pricing drifts and the table is a point-in-time copy. The date is the
   table's "last verified" marker.
2. **Release-checklist re-verification.** `docs/release.md` § "Pre-release
   checklist" requires re-checking each entry against the vendor's current
   price sheet before cutting a version, updating any moved numbers, and
   bumping `DEFAULT_PRICING_SNAPSHOT_DATE` (even if nothing changed, to
   record that the check happened).
3. **Runtime guard for gaps.** `createCostTracker({ warnUnpricedModels })`
   defaults to `true`: a model with no registered price emits a one-time
   warning instead of silently costing $0. `defaultModelPricing` is opt-in,
   so this guard also fires when a user forgets to pass any pricing at all.

The guard catches *missing* prices; the checklist catches *wrong* prices.
Neither alone is sufficient, which is why both exist.

## Alternatives considered

- **Live pricing lookup** (fetch current prices from a vendor/pricing API
  at runtime). Rejected: adds a runtime HTTP dependency (violates ADR-0004)
  and makes cost output non-deterministic — cassettes and cost assertions
  would depend on network state and the clock.
- **Bundle a pricing package that auto-updates** (`@harness-one/pricing`
  with a scheduled data refresh). Rejected for now: the port-in-core /
  sibling pattern could host this later, but it still doesn't make prices
  *live*, and it adds ceremony for a table small enough to eyeball once a
  release. Left as a possible future package, not a v0.x commitment.
- **No default table at all** (force every user to author pricing).
  Rejected: that is the "silent $0" friction we just resolved; the default
  table plus the unpriced-model warning is the better ergonomics.
- **Per-entry `lastVerified` timestamps** on every row instead of one
  table-wide date. Rejected as over-engineering: the whole table is
  re-verified together at release, so a single snapshot date is the honest
  granularity. Revisit if entries ever start moving independently.

## Consequences

### Positive

- Core stays zero-dep and deterministic; cost output is a pure function of
  the (versioned) table, not the network.
- Staleness is bounded and visible: `DEFAULT_PRICING_SNAPSHOT_DATE` tells a
  user exactly how old the numbers are, and the release step keeps it from
  rotting silently.
- The failure mode for an *unknown* model is a loud warning, not a
  confidently-wrong $0.

### Negative

- Prices can be wrong between releases if a vendor re-prices mid-cycle. The
  snapshot date discloses the risk but does not eliminate it — users with
  hard budget requirements should pass their own audited pricing map.
- The re-verification step is manual and easy to skip under release
  pressure; it depends on discipline (and the checklist) rather than
  automation.
- Users who expect "it just knows current prices" have to learn that the
  table is a snapshot and opt into their own source for exact figures.

## Evidence

- `packages/core/src/observe/default-pricing.ts` —
  `DEFAULT_PRICING_SNAPSHOT_DATE` constant + the in-file "vendor pricing
  changes frequently … this snapshot is a point-in-time copy" warning.
- `packages/core/src/observe/cost-tracker.ts` — `warnUnpricedModels`
  defaults to `true`; the unpriced-model warning points users at
  `defaultModelPricing`.
- `packages/core/src/observe/__tests__/default-pricing.test.ts` — locks the
  snapshot's shape and the warning trigger conditions.
- `docs/release.md` § "Pre-release checklist" — the pricing re-verification
  + `DEFAULT_PRICING_SNAPSHOT_DATE` bump step.
- [ADR-0004](./0004-zero-runtime-deps-in-core.md) — the zero-dep rule that
  rules out a live pricing HTTP dependency in core.
