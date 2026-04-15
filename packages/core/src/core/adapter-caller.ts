/**
 * Adapter caller — executes a single non-streaming adapter turn.
 *
 * Wave-5B Step 1 scope: the module exposes only `callOnce`, a thin wrapper
 * around `adapter.chat` that translates a thrown error into a categorized
 * discriminated-union result. Retry ownership and the streaming path remain
 * in `AgentLoop.run()` for this step; they migrate here in Step 2.
 *
 * See `docs/forge-fix/wave-5/wave-5b-adr-v2.md` §2.1 and §7 Step 1.
 *
 * @module
 */

import type { AgentAdapter, Message, TokenUsage, ToolSchema } from './types.js';
import type { HarnessError } from './errors.js';
import { categorizeAdapterError } from './error-classifier.js';

/** Successful single-attempt adapter call result. */
export interface AdapterCallOnceOk {
  readonly ok: true;
  readonly message: Message;
  readonly usage: TokenUsage;
}

/** Failed single-attempt adapter call result. */
export interface AdapterCallOnceFail {
  readonly ok: false;
  readonly error: HarnessError | Error;
  readonly errorCategory: string;
}

/** Discriminated union returned by {@link AdapterCaller.callOnce}. */
export type AdapterCallOnceResult = AdapterCallOnceOk | AdapterCallOnceFail;

/**
 * Minimal configuration for Step 1 of the AdapterCaller extraction.
 *
 * The full {@link AdapterCallerConfig} in the ADR (streaming, retry, signal,
 * streamHandler, onRetry) is introduced in Step 2. Step 1 intentionally keeps
 * the surface narrow: adapter + tools + the abort signal used for the chat
 * call. Everything else lives in `AgentLoop` still.
 */
export interface AdapterCallerConfig {
  readonly adapter: AgentAdapter;
  readonly tools?: readonly ToolSchema[];
  readonly signal: AbortSignal;
}

/** Public surface of the adapter caller. */
export interface AdapterCaller {
  /**
   * Execute a single non-streaming adapter turn. Never throws: errors are
   * caught, categorized via `categorizeAdapterError`, and returned as the
   * `{ok:false}` branch of the discriminated union.
   */
  callOnce(conversation: readonly Message[]): Promise<AdapterCallOnceResult>;
}

/**
 * Build an {@link AdapterCaller} from a {@link AdapterCallerConfig}.
 *
 * The returned object captures the config; the caller owns the abort signal
 * lifecycle (the signal passed in must stay valid for every `callOnce` call).
 */
export function createAdapterCaller(config: Readonly<AdapterCallerConfig>): AdapterCaller {
  return {
    async callOnce(conversation: readonly Message[]): Promise<AdapterCallOnceResult> {
      try {
        const response = await config.adapter.chat({
          messages: conversation,
          signal: config.signal,
          ...(config.tools !== undefined && { tools: config.tools }),
        });
        return { ok: true, message: response.message, usage: response.usage };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return {
          ok: false,
          error,
          errorCategory: categorizeAdapterError(err),
        };
      }
    },
  };
}
