// Stryker mutation-testing config for harness-one/core.
//
// We deliberately DO NOT mutate the entire package. Mutation testing scales
// super-linearly with codebase size and we only need it on the modules whose
// correctness is load-bearing for safety guarantees:
//
//   - src/core/**              — agent loop, iteration, adapter-caller, ...
//   - src/infra/validate.ts    — schema/boundary validation (85% target)
//   - src/guardrails/pipeline.ts — orchestration of content filters / PII /
//                                  schema validation on user-facing surfaces
//
// Everything else (LRU cache, logger, redact, ...) is either trivially
// checked by existing unit tests or covered as a dependency while these
// three targets execute.

export default {
  // pnpm's isolated layout hides transitive plugins from Stryker's default
  // plugin scan, so we load the vitest runner explicitly.
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  vitest: {
    // Stryker-specific config inlines tsconfig so tsconfck doesn't blow
    // up on the repo-root `extends` chain inside the copied sandbox.
    configFile: 'vitest.stryker.config.ts',
  },
  coverageAnalysis: 'perTest',
  mutate: [
    'src/core/**/*.ts',
    'src/infra/validate.ts',
    'src/guardrails/pipeline.ts',
    '!**/*.test.ts',
    '!**/__tests__/**',
  ],
  // break < 80 fails CI. high/low are report-only bands.
  thresholds: { high: 85, low: 80, break: 80 },
  // Most unit tests complete well under a second; 10s is plenty of
  // margin for the slowest integration-style tests while bounding the
  // cost of runaway guards under a mutation-induced infinite loop.
  timeoutMS: 10000,
  concurrency: 4,
  // Static mutants (module-top-level `const` expressions etc.) require a
  // full process restart per run — they dominate wall-clock cost (~85 %
  // for a 10 % share of mutants on src/core/). For a pragmatic signal on
  // test-suite health we sacrifice them; the reporter flags them as
  // `Ignored` with reason `Static mutant`.
  ignoreStatic: true,
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: { fileName: '.stryker-tmp/report/index.html' },
  jsonReporter: { fileName: '.stryker-tmp/report/mutation.json' },
  tempDirName: '.stryker-tmp/sandbox',
  cleanTempDir: true,
};
