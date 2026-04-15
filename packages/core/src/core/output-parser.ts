/**
 * Output parser for structured LLM responses.
 *
 * Provides JSON parsing with markdown code-block extraction
 * and retry-on-parse-failure with self-correction.
 *
 * @module
 */

import type { JsonSchema } from './types.js';
import { HarnessError, HarnessErrorCode} from './errors.js';

/** Parses raw LLM text into a typed value. */
export interface OutputParser<T = unknown> {
  parse(text: string): T;
  getFormatInstructions(): string;
}

/**
 * PERF-18: Cache schema -> JSON string so `getFormatInstructions()` does not
 * re-stringify the same schema on every parse loop iteration.
 *
 * - `WeakMap` covers object schemas (the normal case) and lets the cache
 *   be collected when callers drop the schema.
 * - Primitive/literal schemas can't be keys of a WeakMap; fall back to a
 *   tiny LRU `Map` keyed by `typeof:value` so we still cache but bound memory.
 *
 * These caches are module-scoped and shared across parser instances — the
 * schema identity is what matters, not the parser instance.
 */
const schemaObjectStringCache = new WeakMap<object, string>();
const SCHEMA_PRIMITIVE_LRU_MAX = 32;
const schemaPrimitiveStringCache = new Map<string, string>();

function primitiveKey(schema: unknown): string {
  // `typeof null` is 'object' so we branch null out first.
  if (schema === null) return 'null:';
  const t = typeof schema;
  return `${t}:${String(schema)}`;
}

/** @internal Exposed for tests that want to reset the stringify cache. */
export function __resetSchemaStringCache(): void {
  schemaPrimitiveStringCache.clear();
  // WeakMap intentionally left alone — entries disappear with their keys.
}

function stringifySchemaCached(schema: unknown): string {
  if (schema !== null && (typeof schema === 'object' || typeof schema === 'function')) {
    const cached = schemaObjectStringCache.get(schema as object);
    if (cached !== undefined) return cached;
    const str = JSON.stringify(schema);
    schemaObjectStringCache.set(schema as object, str);
    return str;
  }
  const key = primitiveKey(schema);
  const cached = schemaPrimitiveStringCache.get(key);
  if (cached !== undefined) {
    // Refresh LRU position
    schemaPrimitiveStringCache.delete(key);
    schemaPrimitiveStringCache.set(key, cached);
    return cached;
  }
  const str = JSON.stringify(schema);
  schemaPrimitiveStringCache.set(key, str);
  if (schemaPrimitiveStringCache.size > SCHEMA_PRIMITIVE_LRU_MAX) {
    const oldest = schemaPrimitiveStringCache.keys().next().value;
    if (oldest !== undefined) schemaPrimitiveStringCache.delete(oldest);
  }
  return str;
}

/**
 * Wrapper for JSON.parse that converts native SyntaxError into
 * `HarnessError(HarnessErrorCode.CORE_PARSE_INVALID_JSON)` with a contextual hint and the
 * original error as `cause`. Keeps upstream callers' retry loops informative
 * instead of seeing a bare "Unexpected token" message.
 */
function parseJsonOrThrow<T>(input: string, source: string): T {
  try {
    return JSON.parse(input) as T;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new HarnessError(
        `Failed to parse JSON in ${source}: ${err.message}`,
        HarnessErrorCode.CORE_PARSE_INVALID_JSON,
        'The LLM produced invalid JSON. Regenerate with explicit format instructions, or tighten the response schema.',
        err,
      );
    }
    throw err;
  }
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
      // Handle empty string input
      if (text.trim() === '') {
        throw new HarnessError(
          'Cannot parse empty string as JSON',
          HarnessErrorCode.CORE_PARSE_EMPTY_INPUT,
          'Provide a non-empty string containing valid JSON',
        );
      }

      // Try to extract JSON from markdown code blocks first
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        const inner = jsonMatch[1].trim();
        if (inner === '') {
          throw new HarnessError(
            'Empty code block contains no JSON',
            HarnessErrorCode.CORE_PARSE_EMPTY_CODEBLOCK,
            'Provide valid JSON inside the code block',
          );
        }
        return parseJsonOrThrow<T>(inner, 'code block');
      }

      // Check for unclosed code block (``` without closing ```)
      if (/```(?:json)?\s*[\s\S]+/.test(text) && !/```[\s\S]*```/.test(text)) {
        throw new HarnessError(
          'Unclosed markdown code block',
          HarnessErrorCode.CORE_PARSE_UNCLOSED_CODEBLOCK,
          'Ensure the code block is properly closed with ```',
        );
      }

      return parseJsonOrThrow<T>(text.trim(), 'response text');
    },
    getFormatInstructions(): string {
      // PERF-18: cache the JSON string keyed on the schema identity so repeated
      // parseWithRetry loops that call getFormatInstructions() each iteration
      // don't re-stringify the same schema.
      return schema
        ? `Respond with a JSON object matching this schema: ${stringifySchemaCached(schema)}`
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
/** Options for parseWithRetry. */
export interface ParseWithRetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Timeout in milliseconds for each regenerate call (default: 30000). */
  regenerateTimeoutMs?: number;
}

export async function parseWithRetry<T>(
  parser: OutputParser<T>,
  text: string,
  regenerate: (feedback: string) => Promise<string>,
  maxRetriesOrOptions?: number | ParseWithRetryOptions,
): Promise<{ result: T; attempts: number }> {
  const opts: ParseWithRetryOptions = typeof maxRetriesOrOptions === 'number'
    ? { maxRetries: maxRetriesOrOptions }
    : (maxRetriesOrOptions ?? {});
  const max = opts.maxRetries ?? 3;
  const timeoutMs = opts.regenerateTimeoutMs ?? 30_000;
  let current = text;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return { result: parser.parse(current), attempts: attempt };
    } catch (err) {
      if (attempt === max) throw err;
      const feedback = `Parse failed: ${err instanceof Error ? err.message : String(err)}. ${parser.getFormatInstructions()}`;
      current = await Promise.race([
        regenerate(feedback),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Regenerate timed out')), timeoutMs),
        ),
      ]);
    }
  }
  /* istanbul ignore next -- unreachable after for-loop */
  throw new HarnessError(
    'Unreachable state in output-parser',
    HarnessErrorCode.CORE_INTERNAL_ERROR,
    'This indicates a bug — please file an issue',
  );
}
