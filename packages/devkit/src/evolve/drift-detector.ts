/**
 * Drift detector — compares current values against stored baselines.
 *
 * @module
 */

import { HarnessError } from 'harness-one';
import type { DriftReport, DriftDeviation } from './types.js';

/** Interface for detecting drift from baselines. */
export interface DriftDetector {
  setBaseline(componentId: string, baseline: Record<string, unknown>): void;
  check(componentId: string, current: Record<string, unknown>): DriftReport;
  checkAll(currentValues: Record<string, Record<string, unknown>>): DriftReport[];
  /** Fix 8: Check if a baseline exists for a given metric/component. */
  hasBaseline(componentId: string): boolean;
}

/** Configuration for the drift detector. */
export interface DriftDetectorConfig {
  /** Severity thresholds for numeric deviation ratios. Defaults: low=0.1, medium=0.5. */
  thresholds?: { low: number; medium: number };
  /**
   * Absolute difference thresholds used when the baseline value is exactly 0.
   * Because a ratio-based threshold is undefined for a zero baseline, we fall
   * back to raw absolute differences.  The defaults (low=1, medium=10) are
   * intentionally conservative – callers that measure metrics on vastly
   * different scales (e.g. latency in milliseconds vs. probability [0,1])
   * should override these to values appropriate for their domain.
   */
  zeroBaselineThresholds?: { low: number; medium: number };
}

/**
 * Create a drift detector that compares current values against baselines.
 *
 * @example
 * ```ts
 * const detector = createDriftDetector();
 * detector.setBaseline('comp-1', { latency: 100, accuracy: 0.95 });
 * const report = detector.check('comp-1', { latency: 150, accuracy: 0.90 });
 * ```
 */
export function createDriftDetector(config?: DriftDetectorConfig): DriftDetector {
  const baselines = new Map<string, Record<string, unknown>>();
  const lowThreshold = config?.thresholds?.low ?? 0.1;
  const mediumThreshold = config?.thresholds?.medium ?? 0.5;
  // Zero-baseline thresholds are configurable so callers can adapt to their
  // metric scale (e.g. latency in ms vs. probability scores in [0,1]).
  const zeroLow = config?.zeroBaselineThresholds?.low ?? 1;
  const zeroMedium = config?.zeroBaselineThresholds?.medium ?? 10;

  function classifyWithThresholds(expected: unknown, actual: unknown): 'low' | 'medium' | 'high' {
    if (expected === undefined || actual === undefined) return 'high';
    if (typeof expected === 'number' && typeof actual === 'number') {
      // When baseline is 0 we cannot compute a meaningful ratio, so we use
      // configurable absolute difference thresholds instead.
      if (expected === 0) {
        if (actual === 0) return 'low';
        const abs = Math.abs(actual);
        if (abs < zeroLow) return 'low';
        if (abs < zeroMedium) return 'medium';
        return 'high';
      }
      const ratio = Math.abs(actual - expected) / Math.abs(expected);
      if (ratio > mediumThreshold) return 'high';
      if (ratio > lowThreshold) return 'medium';
      return 'low';
    }
    if (typeof expected !== typeof actual) return 'high';
    return 'medium';
  }

  return {
    setBaseline(componentId, baseline) {
      baselines.set(componentId, { ...baseline });
    },

    // Fix 8: hasBaseline method
    hasBaseline(componentId) {
      return baselines.has(componentId);
    },

    check(componentId, current) {
      const baseline = baselines.get(componentId);
      // Fix 8: Throw if no baseline set
      if (!baseline) {
        throw new HarnessError(
          `No baseline set for component "${componentId}"`,
          'NO_BASELINE',
          'Call setBaseline() before check()',
        );
      }

      const deviations: DriftDeviation[] = [];
      const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);

      for (const key of allKeys) {
        const expected = baseline[key];
        const actual = current[key];

        if (!deepEqual(expected, actual)) {
          deviations.push({
            field: key,
            expected,
            actual,
            severity: classifyWithThresholds(expected, actual),
          });
        }
      }

      return {
        componentId,
        driftDetected: deviations.length > 0,
        baseline,
        current,
        deviations,
        timestamp: Date.now(),
      };
    },

    checkAll(currentValues) {
      const reports: DriftReport[] = [];
      for (const [id, current] of Object.entries(currentValues)) {
        reports.push(this.check(id, current));
      }
      return reports;
    },
  };
}

/** Type guard for plain objects (excludes arrays and null). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown, seen = new WeakSet<object>()): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i], seen));
  }

  if (isRecord(a) && isRecord(b)) {
    // Circular reference protection
    if (seen.has(a)) return true; // already compared, assume equal
    seen.add(a);

    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return Array.from(keys).every((k) => deepEqual(a[k], b[k], seen));
  }

  return false;
}

// classifySeverity is now inlined in createDriftDetector as classifyWithThresholds
// to support configurable thresholds via closure.
