/**
 * Frozen benchmark queries for regression runs.
 *
 * Per DESIGN §6.2, every release reruns the same query corpus so reviewers
 * can diff cost / coverage / orchestration trace metrics across versions.
 * The set is deliberately small and stable; rotate by appending only — never
 * remove an entry without filing a CHANGELOG note.
 */

export interface BenchmarkQuery {
  /** Slug used in report filenames. Lowercase kebab. */
  readonly slug: string;
  /** Human-readable question fed to the Researcher. */
  readonly question: string;
  /** Short tag set for filtering / grouping in reports. */
  readonly tags: readonly string[];
}

export const BENCHMARK_QUERIES: readonly BenchmarkQuery[] = Object.freeze([
  {
    slug: 'langgraph-vs-mastra',
    question:
      'What are the architectural differences between LangGraph and Mastra for building multi-agent workflows?',
    tags: ['frameworks', 'comparison'],
  },
  {
    slug: 'oauth2-best-practices',
    question:
      'What are the current best practices for implementing OAuth2 PKCE in single-page applications?',
    tags: ['security', 'web'],
  },
  {
    slug: 'rust-async-runtimes',
    question:
      'How do tokio, async-std, and smol differ as Rust async runtimes, and when would you pick each?',
    tags: ['rust', 'comparison'],
  },
  {
    slug: 'kafka-vs-pulsar',
    question:
      'How do Apache Kafka and Apache Pulsar compare for tiered-storage event streaming?',
    tags: ['data-platform', 'comparison'],
  },
  {
    slug: 'wasm-component-model',
    question:
      'What is the WASM Component Model and how does it improve on the existing module ecosystem?',
    tags: ['wasm', 'standards'],
  },
] as const);

/** Look up a benchmark query by slug. Returns `undefined` when not found. */
export function findBenchmarkQuery(slug: string): BenchmarkQuery | undefined {
  return BENCHMARK_QUERIES.find((q) => q.slug === slug);
}
