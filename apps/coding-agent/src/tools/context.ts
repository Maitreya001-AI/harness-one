/**
 * Shared dependency bag injected into every coding-agent tool factory.
 *
 * Carrying these as a struct (rather than threading individual params) keeps
 * the tool factories' call-sites short and makes future additions
 * (logger, redactor, telemetry) non-breaking.
 *
 * @module
 */

export interface ToolContext {
  /** Absolute, canonical workspace root. */
  readonly workspace: string;
  /** When `true`, write/shell tools refuse to mutate state. */
  readonly dryRun: boolean;
  /** Maximum bytes a tool may return to the LLM in a single call. */
  readonly maxOutputBytes: number;
  /** Default tool timeout (ms). */
  readonly defaultTimeoutMs: number;
  /**
   * Approval gate for soft-guardrail tools (shell, write_file with large diffs).
   * Returning `{ allow: false, reason }` rewrites the result into a
   * `permission` ToolError without firing the tool body.
   */
  readonly requireApproval?: (request: {
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
    readonly reason: string;
  }) => Promise<{ readonly allow: boolean; readonly reason?: string }>;
  /**
   * Track files written so the public TaskResult can list them.
   * Mutated by `write_file` only.
   */
  readonly recordChangedFile?: (relPath: string) => void;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
