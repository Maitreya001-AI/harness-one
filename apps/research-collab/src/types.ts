/**
 * Cross-module shared types for the research-collab app.
 *
 * Anything that crosses an internal module boundary lives here. Module-private
 * helpers stay inside their own files.
 */

/** Origin of a research run — informational, used for the report only. */
export type RunSource = 'cli' | 'benchmark' | 'library';

/** Top-level research task input. */
export interface ResearchTask {
  /** The natural-language question the user asked. */
  readonly question: string;
  /** Optional caller-supplied id; auto-generated when omitted. */
  readonly id?: string;
  /** Origin marker for observability. */
  readonly source?: RunSource;
}

/** A subquestion produced by the Researcher agent. */
export interface SubQuestion {
  /** Stable index inside the run (1-based, matches the agent's output). */
  readonly index: number;
  /** The actual subquestion the Specialist will answer. */
  readonly text: string;
  /** Short rationale explaining why this subquestion matters. */
  readonly rationale: string;
}

/** A single source citation produced by a Specialist. */
export interface Citation {
  /** Absolute https:// URL the Specialist actually fetched. */
  readonly url: string;
  /** Short page-title-like label for the citation footnote. */
  readonly title: string;
  /** Single-sentence excerpt the Specialist used as evidence. */
  readonly excerpt: string;
}

/** Specialist output for a single subquestion. */
export interface SpecialistAnswer {
  /** Index of the subquestion this answer corresponds to. */
  readonly subQuestionIndex: number;
  /** Free-form answer text (markdown allowed). */
  readonly answer: string;
  /** Citations the Specialist used. May be empty when no source was helpful. */
  readonly citations: readonly Citation[];
  /** Confidence the Specialist assigns to its own answer. */
  readonly confidence: 'high' | 'medium' | 'low';
}

/** Final report produced by the Coordinator. */
export interface ResearchReport {
  /** Full markdown report — what the user actually reads. */
  readonly markdown: string;
  /**
   * Deduplicated, ordered list of citations referenced in the markdown body.
   * Stable across runs of the same input so we can diff between runs.
   */
  readonly citations: readonly Citation[];
  /** Short executive summary the Coordinator surfaces for the CLI. */
  readonly summary: string;
}

/** Per-agent cost slice exposed in the run report. */
export interface AgentCost {
  readonly agent: AgentRole;
  /** USD cost of this agent's harness loop in this run. */
  readonly usd: number;
}

/** Agent roles in the linear pipeline (Open Question 4: MVP linear). */
export type AgentRole = 'researcher' | 'specialist' | 'coordinator';

/** Status of a single Specialist sub-run. */
export type SpecialistStatus = 'success' | 'guardrail_blocked' | 'error';

/** Per-Specialist outcome surfaced in the report (cost + status). */
export interface SpecialistOutcome {
  readonly subQuestionIndex: number;
  readonly status: SpecialistStatus;
  readonly costUsd: number;
  /**
   * If `status !== 'success'`, the error code that classified the failure.
   * `'GUARDRAIL_BLOCKED'` for guardrail blocks; `'PARSE_ERROR'` for invalid
   * model JSON; `'INTERNAL'` otherwise.
   */
  readonly errorCode?: 'GUARDRAIL_BLOCKED' | 'PARSE_ERROR' | 'INTERNAL';
  readonly errorMessage?: string;
}

/** Run status mirrors the dogfood schema for cross-app log compatibility. */
export type RunStatus = 'success' | 'guardrail_blocked' | 'error';

/**
 * Persisted report shape. Lives next to dogfood's `RunReport` schema in
 * spirit — no PII (we fingerprint the question), per-agent cost breakdown,
 * deterministic ISO timestamp.
 */
export interface RunReport {
  readonly schemaVersion: 1;
  readonly harnessVersion: string;
  readonly appVersion: string;
  readonly timestamp: string;
  readonly runId: string;
  readonly source: RunSource;
  readonly questionFingerprint: string;
  readonly durationMs: number;
  readonly status: RunStatus;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly cost: {
    readonly usd: number;
    readonly perAgent: readonly AgentCost[];
  };
  readonly subQuestions: readonly SubQuestion[];
  readonly specialists: readonly SpecialistOutcome[];
  readonly report?: {
    readonly summary: string;
    readonly markdownBytes: number;
    readonly citationCount: number;
  };
  readonly mocked: boolean;
}

/** All agent role names enumerated for type-safe iteration. */
export const AGENT_ROLES: readonly AgentRole[] = ['researcher', 'specialist', 'coordinator'];
