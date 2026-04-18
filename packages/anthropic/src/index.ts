/**
 * The `@harness-one/anthropic` package — Anthropic SDK adapter for harness-one.
 *
 * Provides a full AgentAdapter implementation backed by the Anthropic SDK,
 * with support for chat, streaming, and tool_use handling.
 *
 * The implementation is split across two siblings:
 *   - `./adapter` — factory, config, streaming/chat glue
 *   - `./convert` — pure message / tool / schema / usage conversions
 *
 * @module
 */

export type {
  AnthropicAdapterConfig,
  AnthropicMalformedToolUsePolicy,
} from './adapter.js';
export { createAnthropicAdapter } from './adapter.js';

// Internal test hook — not part of the supported public API, but historically
// exported and listed in the API report. Kept here so the public surface is
// byte-for-byte unchanged across the refactor.
export { _resetWarnedUnknownSchemaKeysForTesting } from './convert.js';
