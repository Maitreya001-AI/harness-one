/**
 * Shared types for the perf bench runner.
 *
 * Each bench case exports a `PerfCase` describing one or more `PerfSample`
 * metrics. Samples are standardized so the runner can diff them against
 * `baseline.json` and gate on drift without per-case special-casing.
 *
 * @module
 */

/**
 * Standardised metric emitted by a bench case. One case may emit several
 * samples (e.g. I1 reports both p50 and p95 under the same case id).
 */
export interface PerfSample {
  /** Fully-qualified metric name — matches keys in `baseline.json`. */
  readonly metric: string;
  /** Human unit for the value (`ns`, `us`, `ms`, `mb`, …). */
  readonly unit: string;
  /** Measured value. Always a number; the unit disambiguates magnitude. */
  readonly value: number;
  /** Number of iterations (or samples) that produced `value`. */
  readonly iterations: number;
  /** ISO-8601 timestamp when the sample was taken. */
  readonly timestamp: string;
}

/** One bench case — emits 1+ samples. */
export interface PerfCase {
  /** Short case id used for `--case=I1` filtering and the report table. */
  readonly id: string;
  /** Human one-liner describing what this case measures. */
  readonly description: string;
  /** Run the case; return the samples it produced. */
  run(): Promise<PerfSample[]>;
}
