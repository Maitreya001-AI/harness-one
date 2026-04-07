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
}

/** A multi-stage guided workflow definition. */
export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly stages: SkillStage[];
  readonly initialStage: string;
}

/** A single stage within a skill workflow. */
export interface SkillStage {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly tools?: string[];
  readonly transitions: StageTransition[];
  readonly maxTurns?: number;
}

/** A transition rule between skill stages. */
export interface StageTransition {
  readonly to: string;
  readonly condition: TransitionCondition;
}

/** Condition types that trigger stage transitions. */
export type TransitionCondition =
  | { type: 'turn_count'; count: number }
  | { type: 'keyword'; keywords: string[] }
  | { type: 'manual' }
  | { type: 'custom'; check: (context: TransitionContext) => boolean };

/** Context passed to custom transition condition checks. */
export interface TransitionContext {
  readonly currentStage: string;
  readonly turnCount: number;
  readonly lastMessage: string;
  readonly history: readonly { role: string; content: string }[];
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
