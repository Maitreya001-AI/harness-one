/**
 * Default configuration constants for the research-collab pipeline.
 *
 * Keep this module tiny and `const`-only so consumers can import individual
 * values without dragging in any side effects.
 */

/** Default LLM model used by Researcher / Specialist / Coordinator. */
export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Default per-task budget in USD. A typical 3-subquestion linear run on
 * Sonnet costs $0.05–$0.20; $2.00 leaves ~10× headroom while still failing
 * fast on a runaway tool loop. Mirrors dogfood's defensive default.
 */
export const DEFAULT_BUDGET_USD = 2.0;

/** Maximum number of subquestions the Researcher is allowed to emit. */
export const MAX_SUBQUESTIONS = 5;

/** Minimum number of subquestions the Researcher must emit. */
export const MIN_SUBQUESTIONS = 1;

/**
 * Maximum number of Specialists running in parallel. Open Question 4 calls for
 * a linear MVP, but specialists across distinct subquestions are independent
 * by construction (no shared state). Bounded so we don't push spurious
 * concurrency through the orchestration subsystem.
 */
export const DEFAULT_SPECIALIST_CONCURRENCY = 3;

/** Cap on the number of web search hits a Specialist can request per call. */
export const MAX_SEARCH_RESULTS = 5;

/** Cap on bytes a single web fetch returns (post-extraction). */
export const MAX_FETCH_BYTES = 64 * 1024;

/**
 * Cap on harness-internal iterations per agent. Researcher only needs one
 * pass; Coordinator the same; Specialists may need to chain a small number
 * of search/fetch calls — six is enough headroom in practice.
 */
export const MAX_AGENT_ITERATIONS = 6;
