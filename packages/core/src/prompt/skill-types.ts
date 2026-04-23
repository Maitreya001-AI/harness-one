/**
 * Skill-registry contracts for the prompt module.
 *
 * @module
 */

/** Default semantic version assigned to skills when omitted by the caller. */
export const DEFAULT_SKILL_VERSION = '1.0.0';

/**
 * A single skill definition stored in a registry.
 *
 * The registry is intentionally agnostic about where the content came from:
 * a string literal, a file, a database row, or a remote fetch are all just
 * `content` by the time they cross this boundary.
 */
export interface SkillDefinition {
  /** Registry-unique skill identifier. */
  readonly id: string;
  /** Optional semantic version. Missing values are normalized to `1.0.0`. */
  readonly version?: string;
  /** Short operator-facing summary used for listing and audit purposes. */
  readonly description: string;
  /** Full prompt-facing skill content, typically Markdown. */
  readonly content: string;
  /** Optional static declaration of tool names this skill expects to use. */
  readonly requiredTools?: readonly string[];
  /** Whether the skill should participate in the stable cacheable prefix. */
  readonly cacheable?: boolean;
  /** Opaque metadata carried for filtering, audit, or instrumentation. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Result of rendering one or more skills into prompt text. */
export interface RenderedSkills {
  /** Fully concatenated prompt content ready for a system message. */
  readonly content: string;
  /** Ordered list of rendered skills in the exact order they were emitted. */
  readonly rendered: ReadonlyArray<{ id: string; version: string }>;
  /** Stable hash of the rendered skill content for cache-hit instrumentation. */
  readonly stableHash: string;
}

/** Static validation result for a requested skill set. */
export interface SkillValidationResult {
  readonly valid: boolean;
  readonly missingTools: readonly string[];
  readonly missingSkills: readonly string[];
}

/** Optional remote source for asynchronously materializing skills. */
export interface SkillBackend {
  fetch(id: string, version?: string): Promise<SkillDefinition | null>;
  list?(): Promise<SkillDefinition[]>;
}

/** Synchronous, in-memory registry of prompt skills. */
export interface SkillRegistry {
  register(skill: SkillDefinition): void;
  get(id: string, version?: string): SkillDefinition | undefined;
  has(id: string): boolean;
  list(filter?: { metadata?: Record<string, unknown> }): SkillDefinition[];
  render(ids: string | readonly string[]): RenderedSkills;
  validate(ids: readonly string[], availableToolNames: readonly string[]): SkillValidationResult;
  size(): number;
  clear(): void;
}

/**
 * Async registry facade backed by a remote source plus local cache.
 *
 * Listing remains synchronous and reflects only the local cache contents.
 * Call `prefetch()` or `get()` first when the remote backend is authoritative.
 */
export interface AsyncSkillRegistry extends Omit<SkillRegistry, 'get' | 'render' | 'validate'> {
  get(id: string, version?: string): Promise<SkillDefinition | undefined>;
  render(ids: string | readonly string[]): Promise<RenderedSkills>;
  validate(ids: readonly string[], availableToolNames: readonly string[]): Promise<SkillValidationResult>;
  prefetch(ids: readonly string[]): Promise<void>;
}
