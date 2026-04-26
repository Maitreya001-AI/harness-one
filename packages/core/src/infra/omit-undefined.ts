/**
 * `omitUndefined` — strip `undefined`-valued keys from an object.
 *
 * Solves the recurring `exactOptionalPropertyTypes: true` friction
 * documented across the monorepo (HARNESS_LOG entries HC-001, HC-014,
 * research-collab L-004). When TypeScript is configured with
 * `exactOptionalPropertyTypes`, the literal `{ field: maybeValue }` no
 * longer matches `{ field?: T }` because the literal carries `undefined`
 * while the type does not include it. The boilerplate workaround is
 *
 * ```ts
 * const cfg = {
 *   ...(value !== undefined && { field: value }),
 * };
 * ```
 *
 * Repeated 6+ times across each app. This helper centralises the
 * pattern so call sites read as
 *
 * ```ts
 * const cfg = omitUndefined({ field: maybeValue, other: x });
 * ```
 *
 * The return type narrows away `undefined` from every value position,
 * matching what `exactOptionalPropertyTypes` expects at downstream
 * consumption sites. Symbol keys are preserved verbatim.
 *
 * @module
 */

/**
 * Object with `undefined` removed from every value-position type.
 *
 * Intentionally NOT marking the keys optional — once `omitUndefined` has
 * stripped the explicit-undefined values, the resulting type's value
 * union excludes `undefined`. Optionality is still encoded by the input
 * type's optional keys; the helper just enforces that no value is
 * literally `undefined` at runtime.
 */
export type WithoutUndefined<T> = {
  [K in keyof T]: Exclude<T[K], undefined>;
};

/**
 * Return a new object with the same own-enumerable string and symbol
 * keys as `obj`, except that any property whose value is `undefined`
 * is omitted entirely.
 *
 * Properties that are `null`, `0`, `''`, `false`, etc. are preserved —
 * only the literal `undefined` is dropped. Inherited properties are
 * NOT copied (matches the spread-operator contract).
 *
 * The returned object is freshly allocated; the input is not mutated.
 *
 * @example
 * ```ts
 * type Cfg = { name: string; timeout?: number; signal?: AbortSignal };
 *
 * function build(timeout: number | undefined, signal: AbortSignal | undefined): Cfg {
 *   return omitUndefined({
 *     name: 'agent',
 *     timeout,
 *     signal,
 *   });
 * }
 * ```
 *
 * @example
 * ```ts
 * omitUndefined({ a: 1, b: undefined, c: null }); // { a: 1, c: null }
 * ```
 */
export function omitUndefined<T extends object>(obj: T): WithoutUndefined<T> {
  const result: Record<PropertyKey, unknown> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== undefined) {
      result[key as PropertyKey] = value;
    }
  }
  // Symbol keys: spec-compliant own-symbol enumeration.
  for (const sym of Object.getOwnPropertySymbols(obj)) {
    const value = (obj as Record<symbol, unknown>)[sym];
    if (value !== undefined) {
      result[sym] = value;
    }
  }
  return result as WithoutUndefined<T>;
}
