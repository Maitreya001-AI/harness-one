/**
 * Shared types for the dogfood agent.
 *
 * Every type exported here crosses a module boundary. Internal helpers stay
 * local to their module.
 */

/** Severity tagged by the agent for the duplicate detector. */
export type DuplicateConfidence = 'high' | 'medium' | 'low';

/**
 * The structured verdict the triage loop must produce before we post a
 * comment. `labels` is constrained to a fixed set so we never accidentally
 * create new labels from free-form model output.
 */
export interface TriageVerdict {
  readonly suggestedLabels: readonly AllowedLabel[];
  readonly duplicates: readonly DuplicateCandidate[];
  readonly reproSteps: readonly string[];
  /** Short one-sentence rationale the model must always provide. */
  readonly rationale: string;
}

export interface DuplicateCandidate {
  readonly issueNumber: number;
  readonly title: string;
  readonly url: string;
  readonly confidence: DuplicateConfidence;
}

/**
 * The closed set of labels the bot is allowed to suggest. Any label outside
 * this set is dropped at render time so the bot cannot smuggle a new label
 * into the repo.
 */
export const ALLOWED_LABELS = [
  'bug',
  'enhancement',
  'documentation',
  'question',
  'adapter',
  'guardrails',
  'observe',
  'rag',
  'session',
  'memory',
  'tools',
  'needs-repro',
  'good-first-issue',
] as const;

export type AllowedLabel = (typeof ALLOWED_LABELS)[number];

export function isAllowedLabel(value: string): value is AllowedLabel {
  return (ALLOWED_LABELS as readonly string[]).includes(value);
}

/**
 * Persisted per-run record under `dogfood-reports/runs/<date>/<issue>.json`.
 * Deliberately excludes raw issue body / comment body to avoid leaking PII
 * that might appear in bug reports. The fingerprint lets us de-duplicate
 * repeat triage attempts across replays without storing content.
 */
export interface RunReport {
  readonly schemaVersion: 1;
  readonly harnessVersion: string;
  readonly timestamp: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueBodyFingerprint: string;
  readonly durationMs: number;
  readonly status: 'success' | 'guardrail_blocked' | 'error';
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly cost: {
    readonly usd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly verdict?: TriageVerdict;
  readonly traceId?: string;
  readonly mocked: boolean;
}
