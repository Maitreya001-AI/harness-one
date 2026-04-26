/**
 * Public entry point for library consumers.
 *
 * The CLI lives in `cli/bin.ts`; importers (tests, future scripts that build
 * their own pipeline) reach for the named exports here.
 */

export { runResearch } from './pipeline/run.js';
export type { RunResearchOptions, RunResearchOutcome } from './pipeline/run.js';
export { runPipeline } from './pipeline/orchestrator.js';
export type {
  PipelineHarnesses,
  RunPipelineInput,
  RunPipelineResult,
  SpecialistFactory,
} from './pipeline/orchestrator.js';

export { buildAgentHarness } from './harness-factory.js';
export type { BuildAgentHarnessOptions } from './harness-factory.js';

export { runResearcher, ResearcherFailure } from './agents/researcher.js';
export type { ResearcherInput, ResearcherResult } from './agents/researcher.js';
export { runSpecialist, registerSpecialistTools, SpecialistFailure } from './agents/specialist.js';
export type { SpecialistInput, SpecialistResult, SpecialistTools } from './agents/specialist.js';
export { runCoordinator, CoordinatorFailure } from './agents/coordinator.js';
export type { CoordinatorInput, CoordinatorResult } from './agents/coordinator.js';

export {
  defineWebSearchTool,
  createSerpApiProvider,
  createBraveSearchProvider,
  createFixtureSearchProvider,
} from './tools/web-search.js';
export type { WebSearchProvider, SearchHit, FixtureSearchEntry } from './tools/web-search.js';

export { defineWebFetchTool, createHttpFetcher, createFixtureFetcher } from './tools/web-fetch.js';
export type { WebFetcher, FetchedPage } from './tools/web-fetch.js';

export { createAdapterSummarizer } from './tools/summarize.js';
export type { Summarizer, SummarizeRequest, SummarizeResult } from './tools/summarize.js';

export { nativeFetchClient } from './tools/http.js';
export type { HttpClient, HttpRequest, HttpResponse } from './tools/http.js';

export { createWebContentGuardrail } from './guardrails/web-content.js';
export type { WebContentGuardrail } from './guardrails/web-content.js';

export {
  ParseError,
  parseSubQuestions,
  parseSpecialistAnswer,
  parseResearchReport,
} from './pipeline/parsers.js';

export { createMockAdapter, DEFAULT_SCRIPT } from './mock-adapter.js';
export type { MockAdapterScript, CreateMockAdapterOptions } from './mock-adapter.js';

export { fingerprint, writeRunReport } from './observability/index.js';

export { BENCHMARK_QUERIES, findBenchmarkQuery } from './config/benchmark-queries.js';
export type { BenchmarkQuery } from './config/benchmark-queries.js';

export {
  DEFAULT_BUDGET_USD,
  DEFAULT_MODEL,
  DEFAULT_SPECIALIST_CONCURRENCY,
  MAX_AGENT_ITERATIONS,
  MAX_FETCH_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_SUBQUESTIONS,
  MIN_SUBQUESTIONS,
} from './config/defaults.js';

export type {
  AgentRole,
  AgentCost,
  Citation,
  ResearchReport,
  ResearchTask,
  RunReport,
  RunSource,
  RunStatus,
  SpecialistAnswer,
  SpecialistOutcome,
  SpecialistStatus,
  SubQuestion,
} from './types.js';
export { AGENT_ROLES } from './types.js';
