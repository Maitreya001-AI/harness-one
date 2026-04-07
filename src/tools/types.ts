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

/** Result of a tool execution — either success with data or failure with feedback. */
export type ToolResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: ToolFeedback };

/** Definition of a tool that can be registered and executed. */
export interface ToolDefinition<TParams = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly execute: (params: TParams, signal?: AbortSignal) => Promise<ToolResult>;
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

/** Create a successful tool result. */
export function toolSuccess<T>(data: T): ToolResult<T> {
  return { success: true, data };
}

/** Create a failed tool result with feedback. */
export function toolError(
  message: string,
  category: ToolFeedback['category'],
  suggestedAction: string,
  retryable = false,
): ToolResult<never> {
  return {
    success: false,
    error: { message, category, suggestedAction, retryable },
  };
}
