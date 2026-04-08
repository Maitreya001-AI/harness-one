/**
 * Output parser for structured LLM responses.
 *
 * Provides JSON parsing with markdown code-block extraction
 * and retry-on-parse-failure with self-correction.
 *
 * @module
 */

import type { JsonSchema } from './types.js';

/** Parses raw LLM text into a typed value. */
export interface OutputParser<T = unknown> {
  parse(text: string): T;
  getFormatInstructions(): string;
}

/**
 * Creates a JSON output parser that extracts and parses JSON from LLM output.
 *
 * Handles JSON wrapped in markdown code blocks (` ```json ... ``` `) as well
 * as raw JSON strings.
 *
 * @example
 * ```ts
 * const parser = createJsonOutputParser<{ name: string }>();
 * const result = parser.parse('```json\n{"name":"Alice"}\n```');
 * // result.name === 'Alice'
 * ```
 */
export function createJsonOutputParser<T = unknown>(schema?: JsonSchema): OutputParser<T> {
  return {
    parse(text: string): T {
      // Try to extract JSON from markdown code blocks first
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
      return JSON.parse(jsonStr) as T;
    },
    getFormatInstructions(): string {
      return schema
        ? `Respond with a JSON object matching this schema: ${JSON.stringify(schema)}`
        : 'Respond with valid JSON.';
    },
  };
}

/**
 * Attempts to parse output, retrying with LLM feedback on failure.
 *
 * On each parse failure, calls `regenerate` with an error message including
 * the parser's format instructions, then retries parsing on the new output.
 *
 * @param parser - The output parser to use
 * @param text - Initial text to parse
 * @param regenerate - Callback that receives error feedback and returns corrected text
 * @param maxRetries - Maximum number of attempts (default: 3)
 * @returns The parsed result and the number of attempts taken
 *
 * @example
 * ```ts
 * const { result, attempts } = await parseWithRetry(
 *   parser,
 *   badJson,
 *   async (feedback) => callLLM(feedback),
 * );
 * ```
 */
export async function parseWithRetry<T>(
  parser: OutputParser<T>,
  text: string,
  regenerate: (feedback: string) => Promise<string>,
  maxRetries?: number,
): Promise<{ result: T; attempts: number }> {
  const max = maxRetries ?? 3;
  let current = text;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return { result: parser.parse(current), attempts: attempt };
    } catch (err) {
      if (attempt === max) throw err;
      const feedback = `Parse failed: ${err instanceof Error ? err.message : String(err)}. ${parser.getFormatInstructions()}`;
      current = await regenerate(feedback);
    }
  }
  /* istanbul ignore next -- unreachable after for-loop */
  throw new Error('Unreachable');
}
