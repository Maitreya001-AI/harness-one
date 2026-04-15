/**
 * Trusted system-message factory.
 *
 * Wave-5E (SEC-A07): `SystemMessage` carries an optional opaque `_trust`
 * brand; messages restored from session/memory storage without the brand
 * are downgraded to `user` by {@link sanitizeRestoredMessage}, so an
 * attacker who can write to the conversation store cannot elevate a
 * user turn into a system prompt.
 *
 * The brand is a process-local `Symbol`. It does NOT survive serialization
 * — that's the point: only freshly-minted instances produced through this
 * factory (by host code with access to the module singleton) count as
 * trusted. Persisted messages lose the brand on write and must be re-
 * minted by the host after restore if they really should carry system
 * authority.
 *
 * @module
 */

import type { Message, SystemMessage, TrustedSystemBrand } from './types.js';

// Process-local symbol — never exported, never serialisable. Any value
// claiming to be `TrustedSystemBrand` must reference-equal this symbol.
const TRUSTED_SYSTEM_BRAND = Symbol('harness-one:TrustedSystemBrand') as unknown as TrustedSystemBrand;

/**
 * Mint a {@link SystemMessage} with the trusted brand. Call this only
 * from host code during boot / configured system-prompt assembly.
 *
 * The returned object's `_trust` field is stripped during JSON
 * serialization (symbols are not enumerable by JSON.stringify), so the
 * brand cannot leak through session persistence or network transport.
 */
export function createTrustedSystemMessage(
  content: string,
  options?: { name?: string },
): SystemMessage {
  return {
    role: 'system',
    content,
    ...(options?.name !== undefined ? { name: options.name } : {}),
    _trust: TRUSTED_SYSTEM_BRAND,
  };
}

/**
 * Returns true when the given message is a `SystemMessage` whose
 * `_trust` brand references the process-local singleton. Any other
 * shape (including ones with a forged `_trust` value) returns false.
 */
export function isTrustedSystemMessage(msg: Message): msg is SystemMessage {
  return msg.role === 'system' && (msg as SystemMessage)._trust === TRUSTED_SYSTEM_BRAND;
}

/**
 * Normalises a message read from persistent storage. If the message
 * claims `role: 'system'` but lacks the trusted brand, returns a
 * `UserMessage` copy with the same content — the safe downgrade
 * prevents elevation-by-storage-write.
 */
export function sanitizeRestoredMessage(msg: Message): Message {
  if (msg.role === 'system' && !isTrustedSystemMessage(msg)) {
    const { role: _role, _trust: _brand, ...rest } = msg as SystemMessage & { _trust?: unknown };
    return { ...rest, role: 'user' } as Message;
  }
  return msg;
}
