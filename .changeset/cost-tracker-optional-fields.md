---
'harness-one': minor
---

`CostTracker.recordUsage` now accepts records with `traceId` and / or
`model` omitted. Missing identifiers route to a stable `'unknown'`
bucket internally so simple callers (single-task budget trackers,
ad-hoc scripts) don't have to fabricate stub IDs that pollute
cost-by-trace / cost-by-model aggregations.

**Behaviour**:

- `traceId` omitted → bucket key is `'unknown'`
- `model` omitted → bucket key is `'unknown'`; the per-record
  unpriced-model warning is suppressed in this case (the warning is
  reserved for callers that supplied a real model name with no
  matching pricing entry)
- Strict mode (`strictMode: true`) still requires both fields and
  throws on omission — unchanged

The stored `TokenUsageRecord` shape is unchanged: `traceId` and
`model` are always populated `string` values on output, so downstream
consumers reading records see no breakage.

`apps/coding-agent/src/agent/budget.ts` simplified to drop the
`traceId: 'coding-agent'` / `model ?? 'unknown'` stubs.

Closes HARNESS_LOG HC-005.
