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
 * @param model - The model name (e.g., 'gpt-4', 'gpt-4o').
 * @returns The created Tokenizer instance.
 */
export function createTiktokenTokenizer(model: string): Tokenizer {
  const encoder = encoding_for_model(model as TiktokenModel);

  const tokenizer: Tokenizer = {
    encode(text: string): { length: number } {
      const tokens = encoder.encode(text);
      return { length: tokens.length };
    },
  };

  registerTokenizer(model, tokenizer);
  return tokenizer;
}
