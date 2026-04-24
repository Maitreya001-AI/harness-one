/**
 * N3 · Branded ID non-assignability.
 *
 * `TraceId` / `SpanId` / `SessionId` are nominal brands over `string` —
 * they share the same underlying primitive but must not be cross-
 * assignable. Locking this at the type level catches the class of bugs
 * where a span id flows into an API expecting a trace id (or vice
 * versa) and the TS compiler would otherwise shrug because both are
 * `string`.
 *
 * These types are not part of the public subpath barrels — they live
 * in `core/types.ts` (which re-exports the canonical definitions from
 * `infra/brands.ts`). The test imports from the source-relative path
 * to pin the internal invariant without widening the public surface.
 */
import { expectTypeOf } from 'expect-type';
import type { Brand, TraceId, SpanId, SessionId } from '../../src/core/types.js';
import { asTraceId, asSpanId, asSessionId } from '../../src/infra/ids.js';

// ── 1. Distinct brands are mutually non-assignable ───────────────────────
expectTypeOf<TraceId>().not.toEqualTypeOf<SpanId>();
expectTypeOf<TraceId>().not.toEqualTypeOf<SessionId>();
expectTypeOf<SpanId>().not.toEqualTypeOf<SessionId>();

expectTypeOf<TraceId>().not.toMatchTypeOf<SpanId>();
expectTypeOf<SpanId>().not.toMatchTypeOf<TraceId>();
expectTypeOf<SessionId>().not.toMatchTypeOf<TraceId>();

// ── 2. Branded ids are still assignable TO string (one-way narrowing) ────
// A branded id can be used anywhere a string is expected (e.g. logging);
// the brand only blocks the reverse direction.
expectTypeOf<TraceId>().toMatchTypeOf<string>();
expectTypeOf<SpanId>().toMatchTypeOf<string>();
expectTypeOf<SessionId>().toMatchTypeOf<string>();

// ── 3. A raw string is NOT assignable to a brand ─────────────────────────
declare const rawString: string;

// @ts-expect-error — raw strings lack the phantom __brand and must go
// through the `asTraceId` factory (or an explicit cast).
const _badTrace: TraceId = rawString;
void _badTrace;

// @ts-expect-error — same for SpanId.
const _badSpan: SpanId = rawString;
void _badSpan;

// @ts-expect-error — same for SessionId.
const _badSession: SessionId = rawString;
void _badSession;

// ── 4. Cross-brand assignment is rejected ────────────────────────────────
declare const someSpan: SpanId;
declare const someTrace: TraceId;

// @ts-expect-error — SpanId → TraceId must fail.
const _x: TraceId = someSpan;
void _x;

// @ts-expect-error — TraceId → SpanId must fail.
const _y: SpanId = someTrace;
void _y;

// ── 5. Factories preserve the brand ──────────────────────────────────────
expectTypeOf(asTraceId('t')).toEqualTypeOf<TraceId>();
expectTypeOf(asSpanId('s')).toEqualTypeOf<SpanId>();
expectTypeOf(asSessionId('u')).toEqualTypeOf<SessionId>();

// ── 6. Brand<T, B> helper shape is the canonical `T & { __brand: B }` ────
// Locks the helper's structure so a refactor can't silently replace it
// with a different brand encoding (e.g. symbol-valued, class-based) that
// would skip compile-time checks.
expectTypeOf<Brand<string, 'Demo'>>().toEqualTypeOf<
  string & { readonly __brand: 'Demo' }
>();
