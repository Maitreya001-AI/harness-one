# dogfood Harness Log

> Continuous friction log. Every time a developer or operator hits a
> harness-one snag while working on or maintaining `apps/dogfood/`,
> append a new entry **at the top** (newest first).
>
> Format requirements live in
> [`docs/harness-one-app-feedback-loop.md`](../../docs/harness-one-app-feedback-loop.md)
> § "HARNESS_LOG.md (continuous friction log)". Entries that don't follow
> the format are pushed back rather than merged — "dev diary" style
> entries have zero feedback value.

---

## 2026-07-03 — `tools.register` 需要 `as unknown as` 双重 cast 才能注册 `defineTool` 结果

**Friction**: `entry.ts` registers a read-only issue-search tool via
`harness.tools.register(defineSearchRecentIssuesTool(...))`, but TypeScript
rejects it: `ToolDefinition<{ query; topK? }>` is not assignable to
`ToolDefinition<unknown>` (loudest under `exactOptionalPropertyTypes`). Root
cause: `ToolDefinition<T>` places `T` in the contravariant `execute(params: T)`
position, so under `strictFunctionTypes` a concrete tool type is *not* a
subtype of `ToolDefinition<unknown>`, which is what `register()` accepted.
research-collab's specialist hit the identical wall — cross-app friction.

**Current workaround**:
```ts
harness.tools.register(
  defineSearchRecentIssuesTool({ gh, repository }) as unknown as Parameters<
    typeof harness.tools.register
  >[0],
);
```

**Feedback action**:
- [x] Fixed in this session — tools typing batch: `register` now accepts the
  variance-safe `AnyToolDefinition` (`ToolDefinition<never>`), so any
  `defineTool<...>` result registers with zero casts. Both app double-casts
  removed; `pnpm --filter @harness-one/dogfood typecheck` passes. Same batch
  added `FromSchema<S>` so an `as const` schema infers `params`. No issue/PR #
  yet.

**Severity**: medium

**Suspected root cause**: `packages/core/src/tools` — the `register` boundary
took `ToolDefinition<unknown>`, which contravariance makes unreachable for
concrete tool params. Fixed by widening to `ToolDefinition<never>`.

---

(No entries yet. The artifact was added when the three-layer
architecture standardized app-level feedback. The first friction
encountered after that should land **above this paragraph**, using the
template below.)

---

## Entry template

```markdown
## YYYY-MM-DD — One-line title naming the API or behavior

**Friction**: Specific API, scenario, and what went wrong. Include a
minimal reproduction (5-15 lines) when possible.

**Current workaround**:
\`\`\`ts
// what we're doing today to ship around it
\`\`\`

**Feedback action**:
- [ ] Issue #
- [ ] PR #
- [ ] RFC docs/rfc/NNNN-xxx.md
- [ ] Pending evaluation (root cause not yet understood)
- [ ] Won't fix (reason: ...)

**Severity**: low / medium / high

**Suspected root cause** (optional): Where in harness-one the fix likely
needs to land + why.
```
