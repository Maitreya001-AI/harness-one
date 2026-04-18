/**
 * Branded-id primitives used by infra (e.g. id generation) and
 * re-exported from `core/core/types.ts` for the rest of the codebase.
 * Lives at L1 so `infra/ids.ts` can reference these types without
 * reaching up into core.
 *
 * @module
 */

/**
 * Nominal brand helper used to produce opaque types that cannot be
 * cross-assigned with other branded strings of the same underlying type.
 *
 * The `__brand` property is phantom — it exists only at the type level. At
 * runtime, a branded value is just its underlying primitive.
 *
 * @example
 * ```ts
 * type UserId = Brand<string, 'UserId'>;
 * const id = '42' as UserId; // requires a cast (or a helper)
 * ```
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Opaque identifier for a trace. Returned by `TraceManager.startTrace()`. */
export type TraceId = Brand<string, 'TraceId'>;

/** Opaque identifier for a span. Returned by `TraceManager.startSpan()`. */
export type SpanId = Brand<string, 'SpanId'>;

/** Opaque identifier for a session. Returned by `SessionManager.create()`. */
export type SessionId = Brand<string, 'SessionId'>;
