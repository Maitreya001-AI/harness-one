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
 * Known tiktoken-supported model names.
 * Used to validate model strings before casting to TiktokenModel,
 * providing clear error messages at the harness boundary.
 */
const KNOWN_TIKTOKEN_MODELS = new Set<string>([
  'gpt-4',
  'gpt-4-0314',
  'gpt-4-0613',
  'gpt-4-32k',
  'gpt-4-32k-0314',
  'gpt-4-32k-0613',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-0301',
  'gpt-3.5-turbo-0613',
  'gpt-3.5-turbo-16k',
  'gpt-3.5-turbo-16k-0613',
  'text-davinci-003',
  'text-davinci-002',
  'text-embedding-ada-002',
]);

/**
 * Check whether a model name is a known tiktoken-supported model.
 */
export function isSupportedTiktokenModel(model: string): model is TiktokenModel {
  return KNOWN_TIKTOKEN_MODELS.has(model);
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
  if (!isSupportedTiktokenModel(model)) {
    throw new Error(
      `Unsupported tiktoken model: "${model}". ` +
      `Supported models include: ${[...KNOWN_TIKTOKEN_MODELS].join(', ')}.`
    );
  }

  let encoder;
  try {
    encoder = encoding_for_model(model);
  } catch (err) {
    throw new Error(
      `Failed to create tiktoken encoder for model "${model}". ` +
      `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const tokenizer: Tokenizer = {
    encode(text: string): { length: number } {
      const tokens = encoder.encode(text);
      return { length: tokens.length };
    },
  };

  registerTokenizer(model, tokenizer);
  return tokenizer;
}
