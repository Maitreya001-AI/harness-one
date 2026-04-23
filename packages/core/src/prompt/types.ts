/**
 * Type definitions for the prompt engineering module.
 *
 * @module
 */

/** A single layer in a multi-layer prompt assembly. */
export interface PromptLayer {
  readonly name: string;
  readonly content: string;
  readonly priority: number;
  readonly cacheable: boolean;
  readonly metadata?: Record<string, unknown>;
}

/** A versioned prompt template with variable placeholders. */
export interface PromptTemplate {
  readonly id: string;
  readonly version: string;
  readonly content: string;
  readonly variables: string[];
  readonly metadata?: Record<string, unknown>;
  /** Optional TTL — epoch milliseconds after which the template is considered expired. */
  readonly expiresAt?: number;
}

/** Backend interface for fetching prompt templates from a remote source (e.g., Langfuse). */
export interface PromptBackend {
  /** Fetch a template by id and optional version from remote source. */
  fetch(id: string, version?: string): Promise<PromptTemplate | undefined>;
  /** List all available templates. */
  list?(): Promise<PromptTemplate[]>;
  /** Optional: Push a template to remote. */
  push?(template: PromptTemplate): Promise<void>;
}

/** The result of assembling a multi-layer prompt. */
export interface AssembledPrompt {
  readonly systemPrompt: string;
  readonly layers: readonly PromptLayer[];
  readonly stablePrefixHash: string;
  readonly metadata: {
    readonly totalTokens: number;
    readonly cacheableTokens: number;
    readonly layerCount: number;
  };
}
