// Install: npm install tiktoken
//
// This example shows how to register tiktoken as a tokenizer in harness-one.
// By default, harness-one uses a heuristic (~4 chars per token). Registering
// tiktoken gives exact BPE token counts for OpenAI models.

import { encoding_for_model, type TiktokenModel } from 'tiktoken';
import { registerTokenizer, countTokens } from 'harness-one/context';
import type { Message } from 'harness-one/core';

// ---------------------------------------------------------------------------
// Create a Tokenizer adapter for tiktoken
// ---------------------------------------------------------------------------

/**
 * Register tiktoken as the tokenizer for a given model.
 *
 * harness-one's Tokenizer interface requires:
 *   { encode(text: string): { length: number } }
 *
 * tiktoken's encoder already returns an array with a .length property,
 * so the mapping is almost direct.
 */
export function registerTiktoken(model: TiktokenModel): void {
  const encoder = encoding_for_model(model);

  // Inject into harness-one's tokenizer registry
  registerTokenizer(model, {
    encode(text: string): { length: number } {
      // tiktoken.encode() returns a Uint32Array — we just need its length
      const tokens = encoder.encode(text);
      return { length: tokens.length };
    },
  });
}

/**
 * Register tiktoken for multiple models at once.
 * Useful when your application switches between models.
 */
export function registerTiktokenModels(models: TiktokenModel[]): void {
  for (const model of models) {
    registerTiktoken(model);
  }
}

// ---------------------------------------------------------------------------
// Example: before/after accuracy comparison
// ---------------------------------------------------------------------------

function demo() {
  const testMessages: readonly Message[] = [
    { role: 'system', content: 'You are a helpful assistant that answers questions concisely.' },
    { role: 'user', content: 'What is the capital of France? Please explain briefly.' },
    {
      role: 'assistant',
      content:
        'The capital of France is Paris. It has been the capital since the late 10th century and is the largest city in France by population.',
    },
  ];

  // Before: heuristic estimate (~4 chars per token)
  const heuristicCount = countTokens('gpt-4o', testMessages);
  console.log(`Heuristic estimate: ${heuristicCount} tokens`);

  // Register tiktoken for gpt-4o
  registerTiktoken('gpt-4o' as TiktokenModel);

  // After: exact BPE count from tiktoken
  const exactCount = countTokens('gpt-4o', testMessages);
  console.log(`Tiktoken exact:     ${exactCount} tokens`);

  // Show the difference
  const diff = Math.abs(heuristicCount - exactCount);
  const pctError = ((diff / exactCount) * 100).toFixed(1);
  console.log(`Difference:         ${diff} tokens (${pctError}% error)`);
  console.log();
  console.log(
    'The heuristic is intentionally conservative. For context window management,',
  );
  console.log(
    'exact counts prevent both under-packing (wasted capacity) and over-packing (truncation).',
  );
}

demo();
