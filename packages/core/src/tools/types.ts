/**
 * Types for the tools module.
 *
 * @module
 */

import type { JsonSchema } from '../core/types.js';

/** Feedback returned when a tool call fails. */
export interface ToolFeedback {
  readonly message: string;
  readonly category: 'validation' | 'permission' | 'not_found' | 'timeout' | 'internal';
  readonly suggestedAction: string;
  readonly retryable: boolean;
}

/**
 * Result of a tool execution — either success with data or failure with feedback.
 *
 * Discriminated by the `kind` tag, with `success: boolean` retained for
 * backward compatibility. New consumers should switch on `result.kind` for
 * exhaustive pattern-matching:
 *
 * ```ts
 * switch (result.kind) {
 *   case 'success': return use(result.data);
 *   case 'error':   return handle(result.error);
 *   // compile-time exhaustiveness — no `default` branch needed.
 * }
 * ```
 *
 * Existing code using `if (result.success)` continues to work unchanged.
 */
export type ToolResult<T = unknown> =
  | { readonly kind: 'success'; readonly success: true; readonly data: T }
  | { readonly kind: 'error'; readonly success: false; readonly error: ToolFeedback };

/**
 * Middleware hook wrapping a single tool execution. Use middleware to add
 * cross-cutting concerns (retry, circuit-breaker, auth headers, timing,
 * request signing, cache) without modifying the tool's own `execute`.
 *
 * The middleware receives the request and a `next` thunk it must call to
 * invoke the wrapped tool. Middleware can mutate/augment the params, guard
 * the call, or transform the result — whatever is appropriate for the
 * concern at hand.
 *
 * @example
 * ```ts
 * const withRetry: ToolMiddleware = async (ctx, next) => {
 *   for (let attempt = 0; attempt < 3; attempt++) {
 *     const result = await next();
 *     if (result.success) return result;
 *     if (!result.error.retryable) return result;
 *   }
 *   return next();
 * };
 * ```
 */
export type ToolMiddleware<TParams = unknown> = (
  ctx: {
    readonly toolName: string;
    readonly params: TParams;
    readonly signal?: AbortSignal;
  },
  next: () => Promise<ToolResult>,
) => Promise<ToolResult>;

/** Definition of a tool that can be registered and executed. */
export interface ToolDefinition<TParams = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly responseFormat?: 'concise' | 'detailed';
  /** Force sequential execution even in parallel mode. Default: false. */
  readonly sequential?: boolean;
  readonly execute: (params: TParams, signal?: AbortSignal) => Promise<ToolResult>;
  /**
   * Optional middleware chain applied around this tool's `execute`. Earlier
   * entries wrap later ones — the first middleware sees the raw invocation
   * and calls `next()` to move down the chain. See ToolMiddleware.
   */
  readonly middleware?: readonly ToolMiddleware<TParams>[];
}

/** A parsed tool call with id, name, and arguments. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** A single validation error with path and message. */
export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly suggestion?: string;
}

/** Custom schema validator interface for injecting external validators (e.g., Ajv). */
export interface SchemaValidator {
  /** Validate params against a JSON schema, returning validity and any errors. */
  validate(schema: JsonSchema, params: unknown): { valid: boolean; errors: ValidationError[] } | Promise<{ valid: boolean; errors: ValidationError[] }>;
}

/**
 * Create a successful tool result.
 *
 * Prefer this helper over constructing `{ success: true, data }` by hand so
 * the return shape stays consistent with `toolError()` and is easy to grep.
 *
 * @example
 * ```ts
 * async function handler({ args }) {
 *   const user = await fetchUser(args.id);
 *   return toolSuccess(user);
 * }
 * ```
 */
export function toolSuccess<T>(data: T): ToolResult<T> {
  return { kind: 'success', success: true, data };
}

/**
 * Create a failed tool result with feedback the agent can act on.
 *
 * `category` hints the agent toward the right recovery strategy:
 * `validation` for input fixable by the agent, `permission` for capability
 * limits, `upstream` for external-dependency failures, `internal` for bugs.
 * `retryable` controls whether the loop will offer another attempt.
 *
 * @example
 * ```ts
 * if (!args.id) {
 *   return toolError('id is required', 'validation', 'supply a non-empty id', false);
 * }
 * ```
 */
export function toolError(
  message: string,
  category: ToolFeedback['category'],
  suggestedAction: string,
  retryable = false,
): ToolResult<never> {
  return {
    kind: 'error',
    success: false,
    error: { message, category, suggestedAction, retryable },
  };
}
