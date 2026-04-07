/**
 * Drift detector — compares current values against stored baselines.
 *
 * @module
 */

import type { DriftReport, DriftDeviation } from './types.js';

/** Interface for detecting drift from baselines. */
export interface DriftDetector {
  setBaseline(componentId: string, baseline: Record<string, unknown>): void;
  check(componentId: string, current: Record<string, unknown>): DriftReport;
  checkAll(currentValues: Record<string, Record<string, unknown>>): DriftReport[];
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
export function createDriftDetector(): DriftDetector {
  const baselines = new Map<string, Record<string, unknown>>();

  return {
    setBaseline(componentId, baseline) {
      baselines.set(componentId, { ...baseline });
    },

    check(componentId, current) {
      const baseline = baselines.get(componentId);
      if (!baseline) {
        return {
          componentId,
          driftDetected: false,
          baseline: {},
          current,
          deviations: [],
          timestamp: Date.now(),
        };
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
            severity: classifySeverity(expected, actual),
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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    return Array.from(keys).every((k) => deepEqual(aObj[k], bObj[k]));
  }

  return false;
}

function classifySeverity(expected: unknown, actual: unknown): 'low' | 'medium' | 'high' {
  // Missing or added field
  if (expected === undefined || actual === undefined) return 'high';

  // Numeric deviation
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (expected === 0) return actual === 0 ? 'low' : 'high';
    const ratio = Math.abs(actual - expected) / Math.abs(expected);
    if (ratio > 0.5) return 'high';
    if (ratio > 0.1) return 'medium';
    return 'low';
  }

  // Type change
  if (typeof expected !== typeof actual) return 'high';

  return 'medium';
}
