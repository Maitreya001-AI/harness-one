/**
 * Built-in scorers for evaluation — relevance, faithfulness, length, and custom.
 *
 * @module
 */

import type { Scorer } from './types.js';

/**
 * Create a relevance scorer that measures keyword overlap between input and output.
 *
 * @example
 * ```ts
 * const scorer = createRelevanceScorer();
 * const { score } = await scorer.score('What is AI?', 'AI is artificial intelligence.');
 * ```
 */
export function createRelevanceScorer(): Scorer {
  return {
    name: 'relevance',
    description: 'Measures keyword overlap between input and output',
    async score(input: string, output: string) {
      const inputTokens = tokenize(input);
      const outputTokens = tokenize(output);

      if (inputTokens.length === 0) {
        return { score: 1.0, explanation: 'Empty input — treated as relevant' };
      }

      const matched = inputTokens.filter((t) => outputTokens.includes(t));
      const score = matched.length / inputTokens.length;

      return {
        score,
        explanation: `${matched.length}/${inputTokens.length} input keywords found in output`,
      };
    },
  };
}

/**
 * Create a faithfulness scorer that checks if output claims are grounded in context.
 *
 * @example
 * ```ts
 * const scorer = createFaithfulnessScorer();
 * const { score } = await scorer.score('question', 'answer based on context', 'the context');
 * ```
 */
export function createFaithfulnessScorer(): Scorer {
  return {
    name: 'faithfulness',
    description: 'Measures how well output claims are grounded in provided context',
    async score(_input: string, output: string, context?: string) {
      if (!context) {
        return { score: 1.0, explanation: 'No context provided — skipping faithfulness check' };
      }

      const outputClaims = tokenize(output);
      const contextTokens = tokenize(context);

      if (outputClaims.length === 0) {
        return { score: 0.0, explanation: 'Empty output' };
      }

      const grounded = outputClaims.filter((t) => contextTokens.includes(t));
      const score = grounded.length / outputClaims.length;

      return {
        score,
        explanation: `${grounded.length}/${outputClaims.length} output tokens grounded in context`,
      };
    },
  };
}

/**
 * Create a length scorer that checks if output is within token bounds.
 *
 * @example
 * ```ts
 * const scorer = createLengthScorer({ minTokens: 10, maxTokens: 200 });
 * ```
 */
export function createLengthScorer(config: {
  minTokens?: number;
  maxTokens?: number;
}): Scorer {
  const { minTokens = 0, maxTokens = Infinity } = config;

  return {
    name: 'length',
    description: `Checks output length is between ${minTokens} and ${maxTokens} tokens`,
    async score(_input: string, output: string) {
      const tokens = tokenize(output).length;

      if (tokens < minTokens) {
        const score = minTokens === 0 ? 0 : tokens / minTokens;
        return {
          score,
          explanation: `Output has ${tokens} tokens, below minimum ${minTokens}`,
        };
      }

      if (tokens > maxTokens) {
        const score = maxTokens === 0 ? 0 : maxTokens / tokens;
        return {
          score,
          explanation: `Output has ${tokens} tokens, above maximum ${maxTokens}`,
        };
      }

      return {
        score: 1.0,
        explanation: `Output has ${tokens} tokens, within bounds [${minTokens}, ${maxTokens}]`,
      };
    },
  };
}

/**
 * Create a custom scorer from a user-provided scoring function.
 *
 * @example
 * ```ts
 * const scorer = createCustomScorer({
 *   name: 'polite',
 *   description: 'Checks if output is polite',
 *   scoreFn: async (input, output) => ({ score: output.includes('please') ? 1 : 0, explanation: 'Politeness check' }),
 * });
 * ```
 */
export function createCustomScorer(config: {
  name: string;
  description: string;
  scoreFn: (input: string, output: string, context?: string) => Promise<{ score: number; explanation: string }>;
}): Scorer {
  return {
    name: config.name,
    description: config.description,
    score: config.scoreFn,
  };
}

/** Tokenize text into lowercase words, filtering out stopwords. */
function tokenize(text: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'and', 'or',
    'but', 'not', 'no', 'if', 'then', 'so', 'as', 'what', 'which', 'who',
  ]);

  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 1 && !stopwords.has(w));
}
