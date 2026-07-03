/**
 * Type-level JSON-Schema → TypeScript inference for tool parameters.
 *
 * This module is **entirely type-level** — it emits no runtime code and adds
 * zero dependencies. It maps the JSON-Schema subset `harness-one` supports
 * (`type`, `properties`, `items`, `required`, `enum` over the primitive types
 * `string` / `number` / `integer` / `boolean` / `object` / `array` / `null`)
 * to the TypeScript type a tool's `execute(params)` should receive.
 *
 * The inference is intentionally **conservative**: it only fires for a schema
 * that has been frozen with `as const` (so its literal shape survives into the
 * type system). A plain, un-frozen schema literal — or the widened
 * {@link JsonSchema} interface — falls back to `unknown`, exactly matching the
 * pre-inference behaviour. That gate is what keeps the enhancement backward
 * compatible: existing `defineTool` calls that never used `as const` keep
 * seeing `unknown` params.
 *
 * @example
 * ```ts
 * const schema = {
 *   type: 'object',
 *   properties: { q: { type: 'string' }, limit: { type: 'number' } },
 *   required: ['q'],
 * } as const;
 * type Params = FromSchema<typeof schema>; // { q: string; limit?: number }
 * ```
 *
 * @module
 */

import type { JsonSchema } from '../core/types.js';

/**
 * Deep-`readonly` view of a value. Used to type the `parameters` field of the
 * schema-inference `defineTool` overload so an `as const` schema literal (whose
 * arrays become `readonly` tuples) is assignable to the constraint while still
 * being validated against the {@link JsonSchema} shape.
 */
export type DeepReadonly<T> =
  T extends (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * A `JsonSchema` in the shape an `as const` literal produces — every field
 * deeply `readonly`. This is the accepted constraint for the schema-inference
 * `defineTool` overload; a mutable schema literal is assignable to it too, but
 * {@link FromSchema} only infers when the literal is genuinely frozen.
 */
export type ReadonlyJsonSchema = DeepReadonly<JsonSchema>;

/** Map a single JSON-Schema primitive `type` name to its TypeScript type. */
type PrimitiveFromType<T> =
  [T] extends ['string']
    ? string
    : [T] extends ['number']
      ? number
      : [T] extends ['integer']
        ? number
        : [T] extends ['boolean']
          ? boolean
          : [T] extends ['null']
            ? null
            : unknown;

/** Flatten an intersection into a single, readable object type. */
type Simplify<T> = { [K in keyof T]: T[K] };

/** Strip `readonly` modifiers from every top-level property. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Structural equality that is sensitive to `readonly` modifiers (the classic
 * identity-function encoding). `readonly`-ness is not observable through plain
 * assignability, so this is the reliable way to tell an `as const` literal
 * (frozen, `readonly` props) apart from a plain object literal.
 */
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/**
 * True when `S` looks like an `as const`-frozen schema. A plain schema literal
 * keeps mutable top-level properties, so it equals its own {@link Writable}
 * form and is treated as *not* frozen — the fallback-to-`unknown` gate.
 */
type IsConstSchema<S> = S extends object
  ? IsEqual<S, Writable<S>> extends true
    ? false
    : true
  : false;

/** Extract the union of `required` property names from a frozen schema. */
type RequiredKeys<S> = S extends { readonly required: infer R }
  ? R extends readonly unknown[]
    ? R[number]
    : never
  : never;

/**
 * Build an object type from a schema's `properties`, honouring `required`.
 *
 * The `-readonly` modifier strips the `readonly`-ness that `as const` stamps
 * onto every property, so the inferred params object is a plain mutable shape
 * (`{ q: string }`, not `{ readonly q: string }`) — what an `execute` handler
 * naturally expects for JSON-parsed arguments.
 */
type FromObjectSchema<S> = S extends { readonly properties: infer P }
  ? Simplify<
      { -readonly [K in keyof P as K extends RequiredKeys<S> ? K : never]: FromSchema<P[K]> } & {
        -readonly [K in keyof P as K extends RequiredKeys<S> ? never : K]?: FromSchema<P[K]>;
      }
    >
  : Record<string, unknown>;

/** Build an array type from a schema's `items`. */
type FromArraySchema<S> = S extends { readonly items: infer I } ? FromSchema<I>[] : unknown[];

/** Core mapping, applied only after the {@link IsConstSchema} gate passes. */
type FromSchemaInner<S> = S extends { readonly enum: infer E }
  ? E extends readonly unknown[]
    ? E[number]
    : unknown
  : S extends { readonly type: 'object' }
    ? FromObjectSchema<S>
    : S extends { readonly type: 'array' }
      ? FromArraySchema<S>
      : S extends { readonly type: infer T }
        ? PrimitiveFromType<T>
        : unknown;

/**
 * Infer the TypeScript parameter type described by a JSON-Schema literal.
 *
 * Returns `unknown` unless `S` is an `as const`-frozen schema — see the module
 * doc for the rationale behind the conservative gate.
 *
 * @typeParam S - A schema literal, typically `typeof mySchema` where
 *   `mySchema` was declared with `as const`.
 */
export type FromSchema<S> = IsConstSchema<S> extends true ? FromSchemaInner<S> : unknown;
