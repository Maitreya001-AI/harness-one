/**
 * @harness-one/tiktoken — Tiktoken tokenizer integration for harness-one.
 *
 * Provides exact BPE token counting via tiktoken, replacing the built-in
 * heuristic estimator for supported models.
 *
 * @module
 */

import { encoding_for_model, type TiktokenModel } from 'tiktoken';
import { registerTokenizer } from 'harness-one/context';

/** Tokenizer interface matching harness-one's internal contract. */
export interface Tokenizer {
  encode(text: string): { length: number };
}

/**
 * Internal shape of the tiktoken native encoder we hold on to so we can
 * `.free()` the underlying WASM memory on disposal.
 *
 * `encoding_for_model()` returns a native object with `.encode()` and a
 * `.free()` method that releases the underlying WASM allocation. TypeScript's
 * bundled types may not surface `.free()` on every release, so we treat it as
 * optional.
 */
interface NativeEncoder {
  encode(text: string): Uint32Array;
  free?: () => void;
}

/** Cache entry pairs the public Tokenizer with the native encoder that owns the WASM memory. */
interface CachedEntry {
  readonly tokenizer: Tokenizer;
  readonly encoder: NativeEncoder;
}

/**
 * Module-level encoder cache. Avoids expensive encoder creation on every call.
 * Maps model name -> cached entry.
 */
const encoderCache = new Map<string, CachedEntry>();

/** Default models to register when no model list is provided. */
const DEFAULT_MODELS: string[] = [
  'gpt-4',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-3.5-turbo',
];

/** Tracks whether default models have been registered to prevent redundant global mutations. */
let defaultsRegistered = false;

/**
 * Register tiktoken encoders for common models.
 *
 * When called without arguments, registers encoders for:
 * gpt-4, gpt-4o, gpt-4o-mini, gpt-3.5-turbo.
 *
 * Safe to call multiple times — subsequent calls with no arguments are no-ops
 * when defaults are already registered. Explicit model lists always register.
 *
 * @param models - Optional list of model names to register.
 */
export function registerTiktokenModels(models?: string[]): void {
  if (!models && defaultsRegistered) return;
  const modelList = models ?? DEFAULT_MODELS;
  for (const model of modelList) {
    createTiktokenTokenizer(model);
  }
  if (!models) defaultsRegistered = true;
}

/**
 * Create a Tokenizer using tiktoken for a specific model and register it
 * with harness-one's tokenizer registry.
 *
 * Instead of validating against a hardcoded model list, this function
 * delegates to tiktoken's own `encoding_for_model()` and catches any
 * errors for unsupported models. This automatically supports new models
 * as tiktoken updates its registry.
 *
 * Encoders are cached per model to avoid expensive recreation on every call.
 *
 * @param model - The model name (e.g., 'gpt-4', 'gpt-4o').
 * @returns The created Tokenizer instance.
 */
export function createTiktokenTokenizer(model: string): Tokenizer {
  // Check encoder cache first
  const cached = encoderCache.get(model);
  if (cached) {
    return cached.tokenizer;
  }

  let encoder: NativeEncoder;
  try {
    encoder = encoding_for_model(model as TiktokenModel) as unknown as NativeEncoder;
  } catch (err) {
    throw new Error(
      `Unsupported or failed tiktoken model: "${model}". ` +
      `Ensure the model name is valid for tiktoken. ` +
      `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const tokenizer: Tokenizer = {
    encode(text: string): { length: number } {
      const tokens = encoder.encode(text);
      return { length: tokens.length };
    },
  };

  // Cache the encoder for subsequent calls
  encoderCache.set(model, { tokenizer, encoder });

  registerTokenizer(model, tokenizer);
  return tokenizer;
}

/**
 * Release all cached tiktoken WASM encoders and clear the module-level cache.
 *
 * CQ-012 fix: the tiktoken package allocates native WASM memory per encoder
 * (via `encoding_for_model()`). Because we cache encoders for the lifetime of
 * the process, long-running or frequently-restarting-in-place harnesses can
 * accumulate WASM allocations that the JS GC cannot reclaim directly. Hosts
 * that want a clean shutdown (e.g. between test runs, during graceful
 * reload, or when dynamically swapping model lists) MUST call this to free
 * that native memory.
 *
 * After disposal, subsequent calls to `createTiktokenTokenizer(model)` will
 * re-create and re-register encoders on demand, and `registerTiktokenModels()`
 * (with no args) will re-register the defaults since the internal
 * "defaults-registered" flag is also reset.
 *
 * The function is idempotent — calling it twice in a row is safe.
 */
export function disposeTiktoken(): void {
  for (const { encoder } of encoderCache.values()) {
    // `.free()` may not be present on every tiktoken build; guard defensively.
    encoder.free?.();
  }
  encoderCache.clear();
  // Reset so a subsequent registerTiktokenModels() with no args re-registers defaults.
  defaultsRegistered = false;
}
