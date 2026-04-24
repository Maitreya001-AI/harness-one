/**
 * N4 · TrustedSystemMessage brand source lock.
 *
 * `SystemMessage._trust: TrustedSystemBrand` is a nominal brand over
 * `symbol`. At runtime, the brand is a module-local `Symbol` — the only
 * public mint surface is `createTrustedSystemMessage()`. The brand is
 * not serialised and is stripped by `sanitizeRestoredMessage` on
 * restore, so an attacker who can write to the session store cannot
 * elevate a user message into a system prompt.
 *
 * This file locks the compile-time half of that invariant:
 *
 *   1. A plain `symbol` is NOT assignable to `TrustedSystemBrand` —
 *      consumers cannot hand-construct the brand.
 *   2. `createTrustedSystemMessage()` returns a `SystemMessage` whose
 *      `_trust` field has type `TrustedSystemBrand` (never `symbol` or
 *      `undefined`).
 *   3. The canonical `Brand<symbol, 'TrustedSystemBrand'>` shape is
 *      preserved — a refactor cannot silently replace the encoding.
 */
import { expectTypeOf } from 'expect-type';
import type { Brand, SystemMessage, TrustedSystemBrand } from '../../src/core/types.js';
import {
  createTrustedSystemMessage,
  isTrustedSystemMessage,
} from '../../src/core/trusted-system-message.js';

// ── 1. Brand shape lock ──────────────────────────────────────────────────
expectTypeOf<TrustedSystemBrand>().toEqualTypeOf<
  Brand<symbol, 'TrustedSystemBrand'>
>();

// `symbol` lacks the phantom `__brand` field, so it is NOT assignable to
// `TrustedSystemBrand`.
expectTypeOf<symbol>().not.toMatchTypeOf<TrustedSystemBrand>();
expectTypeOf<TrustedSystemBrand>().toMatchTypeOf<symbol>(); // brand narrows to symbol one-way

// ── 2. No hand-construction of the brand ─────────────────────────────────
// @ts-expect-error — a freshly-constructed Symbol is not a TrustedSystemBrand.
const _forged: TrustedSystemBrand = Symbol('fake');
void _forged;

// @ts-expect-error — even a well-known symbol can't impersonate the brand.
const _forged2: TrustedSystemBrand = Symbol.for('harness-one:TrustedSystemBrand');
void _forged2;

// ── 3. Factory is the only public mint surface ───────────────────────────
// `createTrustedSystemMessage` returns `SystemMessage`. The returned
// object carries `_trust: TrustedSystemBrand` at runtime; the type of
// `_trust` on `SystemMessage` is the optional brand, so we lock the
// field's type instead of its presence.
const minted = createTrustedSystemMessage('boot-time instructions');
expectTypeOf(minted).toEqualTypeOf<SystemMessage>();
expectTypeOf<SystemMessage['_trust']>().toEqualTypeOf<TrustedSystemBrand | undefined>();

// ── 4. Type guard narrows to SystemMessage ───────────────────────────────
declare const unknownMessage: import('../../src/core/types.js').Message;
if (isTrustedSystemMessage(unknownMessage)) {
  expectTypeOf(unknownMessage).toMatchTypeOf<SystemMessage>();
}

// ── 5. Raw string literal is not a SystemMessage _trust field ────────────
// Catches the "stringify the brand and pass it along" class of mistakes.
expectTypeOf<string>().not.toMatchTypeOf<TrustedSystemBrand>();
expectTypeOf<'TrustedSystemBrand'>().not.toMatchTypeOf<TrustedSystemBrand>();
