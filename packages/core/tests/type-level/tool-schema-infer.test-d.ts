/**
 * N7 · `FromSchema<S>` schema→params inference + zero-cast `register`.
 *
 * Two invariants are locked here:
 *
 *   1. `FromSchema<S>` maps an `as const` JSON-Schema literal (the subset
 *      harness-one supports) to the TypeScript params type, and conservatively
 *      falls back to `unknown` when the schema is *not* `as const` — so the
 *      enhancement is backward compatible.
 *   2. A `defineTool<{...}>(...)` result — concrete, contravariant in its
 *      params — registers via `ToolRegistry.register` with **zero casts**,
 *      because `register` accepts the variance-safe `AnyToolDefinition`
 *      (`ToolDefinition<never>`). This is the friction the double-cast
 *      `tool as unknown as Parameters<typeof register>[0]` used to paper over.
 */
import { expectTypeOf } from 'expect-type';
import type { JsonSchema } from 'harness-one/core';
import { defineTool, toolSuccess } from 'harness-one/tools';
import type {
  FromSchema,
  ToolDefinition,
  AnyToolDefinition,
  ToolRegistry,
} from 'harness-one/tools';

// ── 1. Primitive props: string / number / integer / boolean ──────────────
const _primSchema = {
  type: 'object',
  properties: {
    s: { type: 'string' },
    n: { type: 'number' },
    i: { type: 'integer' },
    b: { type: 'boolean' },
  },
  required: ['s', 'n', 'i', 'b'],
} as const;
expectTypeOf<FromSchema<typeof _primSchema>>().toEqualTypeOf<{
  s: string;
  n: number;
  i: number; // integer → number
  b: boolean;
}>();

// ── 2. required vs optional ───────────────────────────────────────────────
const _reqSchema = {
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'number' } },
  required: ['a'],
} as const;
expectTypeOf<FromSchema<typeof _reqSchema>>().toEqualTypeOf<{ a: string; b?: number }>();

// ── 3. Nested object ──────────────────────────────────────────────────────
const _nestedSchema = {
  type: 'object',
  properties: {
    user: {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name'],
    },
  },
  required: ['user'],
} as const;
expectTypeOf<FromSchema<typeof _nestedSchema>>().toEqualTypeOf<{
  user: { name: string; age?: number };
}>();

// ── 4. Array of strings ───────────────────────────────────────────────────
const _arrSchema = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' } } },
  required: ['tags'],
} as const;
expectTypeOf<FromSchema<typeof _arrSchema>>().toEqualTypeOf<{ tags: string[] }>();

// ── 5. Enum literal union ─────────────────────────────────────────────────
const _enumSchema = {
  type: 'object',
  properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
  required: ['mode'],
} as const;
expectTypeOf<FromSchema<typeof _enumSchema>>().toEqualTypeOf<{ mode: 'fast' | 'slow' }>();

const _topEnum = { type: 'string', enum: ['a', 'b', 'c'] } as const;
expectTypeOf<FromSchema<typeof _topEnum>>().toEqualTypeOf<'a' | 'b' | 'c'>();

// ── 6. Fallback to `unknown` without `as const` ───────────────────────────
// A plain (non-frozen) schema literal keeps mutable props and must NOT infer.
const _looseSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
};
expectTypeOf<FromSchema<typeof _looseSchema>>().toEqualTypeOf<unknown>();
// The widened `JsonSchema` interface also yields `unknown`.
expectTypeOf<FromSchema<JsonSchema>>().toEqualTypeOf<unknown>();

// ── 7. defineTool infers params from an `as const` schema ─────────────────
const inferredTool = defineTool({
  name: 'search',
  description: 'Search issues',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string' }, limit: { type: 'number' } },
    required: ['q'],
  } as const,
  execute: async (params) => {
    expectTypeOf(params).toEqualTypeOf<{ q: string; limit?: number }>();
    return toolSuccess(params.q);
  },
});
expectTypeOf(inferredTool).toEqualTypeOf<ToolDefinition<{ q: string; limit?: number }>>();

// ── 8. Explicit-generic form stays backward compatible ────────────────────
const explicitTool = defineTool<{ url: string }>({
  name: 'fetch',
  description: 'Fetch a URL',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  execute: async (params) => {
    expectTypeOf(params).toEqualTypeOf<{ url: string }>();
    return toolSuccess(params.url);
  },
});
expectTypeOf(explicitTool).toEqualTypeOf<ToolDefinition<{ url: string }>>();

// ── 9. No `as const`, no generic → params is `unknown` (as today) ─────────
const looseTool = defineTool({
  name: 'loose',
  description: 'no as const',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  execute: async (params) => {
    expectTypeOf(params).toEqualTypeOf<unknown>();
    return toolSuccess(null);
  },
});
void looseTool;

// ── 10. ZERO-cast registration (the killed double-cast) ───────────────────
declare const registry: ToolRegistry;
// Both register with no `as unknown as ...` — the whole point of the fix.
registry.register(inferredTool);
registry.register(explicitTool);
registry.register(looseTool);

// `AnyToolDefinition` is the variance-safe supertype of every concrete tool.
expectTypeOf<ToolDefinition<{ q: string }>>().toMatchTypeOf<AnyToolDefinition>();
expectTypeOf<ToolDefinition<{ url: string }>>().toMatchTypeOf<AnyToolDefinition>();
// Parameters of `register` are exactly `AnyToolDefinition`.
expectTypeOf<Parameters<ToolRegistry['register']>[0]>().toEqualTypeOf<AnyToolDefinition>();
