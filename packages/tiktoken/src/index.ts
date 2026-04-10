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
 * Module-level encoder cache. Avoids expensive encoder creation on every call.
 * Maps model name -> cached Tokenizer instance.
 */
const encoderCache = new Map<string, Tokenizer>();

/** Default models to register when no model list is provided. */
const DEFAULT_MODELS: string[] = [
  'gpt-4',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-3.5-turbo',
];

/**
 * Register tiktoken encoders for common models.
 *
 * When called without arguments, registers encoders for:
 * gpt-4, gpt-4o, gpt-4o-mini, gpt-3.5-turbo.
 *
 * @param models - Optional list of model names to register.
 */
export function registerTiktokenModels(models?: string[]): void {
  const modelList = models ?? DEFAULT_MODELS;
  for (const model of modelList) {
    createTiktokenTokenizer(model);
  }
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
    return cached;
  }

  let encoder;
  try {
    encoder = encoding_for_model(model as TiktokenModel);
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
  encoderCache.set(model, tokenizer);

  registerTokenizer(model, tokenizer);
  return tokenizer;
}
