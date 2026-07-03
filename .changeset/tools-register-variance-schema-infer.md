---
"harness-one": minor
---

Tools: zero-cast tool registration + type-level schema→params inference.

- **`register` variance fix (kills the cross-app double-cast).**
  `ToolDefinition<T>` is contravariant in `T` (it appears in
  `execute(params: T)`), so under `strictFunctionTypes` a concrete
  `ToolDefinition<{ q: string }>` was *not* assignable to
  `ToolDefinition<unknown>` — the type `register()` used to accept. That forced
  callers to write `tool as unknown as Parameters<typeof register>[0]`.
  `ToolRegistry.register` now accepts the new variance-safe alias
  `AnyToolDefinition` (`ToolDefinition<never>`); since `never` is assignable to
  any `T`, every `defineTool<...>()` result registers with **zero casts** while
  callers of a concrete tool's `execute` keep full parameter typing. Params are
  still validated against `tool.parameters` at execution time.

- **`FromSchema<S>` schema → TypeScript inference (type-level, zero runtime
  deps).** New exported type utility maps the supported JSON-Schema subset
  (`type` over `string`/`number`/`integer`/`boolean`/`object`/`array`/`null`,
  plus `properties`, `items`, `required`, `enum`) of an `as const` schema
  literal to a params type. `defineTool` gains an overload so
  `defineTool({ parameters: { ... } as const, execute: (params) => ... })`
  infers `params` from the schema — no explicit generic needed. Conservative by
  design: a schema without `as const` (or the widened `JsonSchema` interface)
  falls back to `unknown`, exactly as before. The explicit-generic form
  `defineTool<T>({ ... })` is unchanged and backward compatible.

New public exports from `harness-one/tools`: `AnyToolDefinition`,
`FromSchema`, `ReadonlyJsonSchema`, `DeepReadonly` (all type-only).
