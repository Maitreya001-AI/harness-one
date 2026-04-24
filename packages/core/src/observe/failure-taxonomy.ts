/**
 * Failure taxonomy for classifying agent failures from trace structure.
 *
 * @module
 */

import type {
  Trace,
  FailureClassification,
  FailureDetector,
  FailureTaxonomy,
  FailureTaxonomyConfig,
} from './types.js';
import { HarnessErrorCode } from '../core/errors.js';
import { isRetryableHarnessErrorCode } from '../core/error-span-attributes.js';

// ---------------------------------------------------------------------------
// Built-in detectors
// ---------------------------------------------------------------------------

/** Detect N consecutive spans with the same name (≥minRun, default 3). */
function createToolLoopDetector(minRun = 3): FailureDetector {
  return {
    detect(trace: Trace) {
      const spans = trace.spans;
      if (spans.length < minRun) return null;

      let maxRun = 1;
      let currentRun = 1;

      for (let i = 1; i < spans.length; i++) {
        if (spans[i].name === spans[i - 1].name) {
          currentRun++;
          if (currentRun > maxRun) maxRun = currentRun;
        } else {
          currentRun = 1;
        }
      }

      if (maxRun < minRun) return null;

      // Empirically chosen, pending validation against production data.
      // Calibrate using eval framework. Base confidence 0.5 with +0.1 per
      // additional consecutive span beyond minRun, capped at 0.95.
      const confidence = Math.min(0.5 + (maxRun - minRun) * 0.1, 0.95);
      return {
        confidence,
        evidence: `${maxRun} consecutive spans with the same name`,
      };
    },
  };
}

/** Detect completed trace with ≤maxSpans spans and <5s duration. */
function createEarlyStopDetector(maxSpans = 2): FailureDetector {
  return {
    detect(trace: Trace) {
      if (trace.status !== 'completed') return null;
      if (trace.spans.length > maxSpans) return null;

      const duration = (trace.endTime ?? trace.startTime) - trace.startTime;
      if (duration >= 5000) return null;

      // Empirically chosen, pending validation against production data.
      // Calibrate using eval framework.
      return {
        confidence: 0.6,
        evidence: `Trace completed with ${trace.spans.length} span(s) in ${duration}ms`,
      };
    },
  };
}

/** Detect budget-exceeded failures, preferring structured error codes. */
function createBudgetExceededDetector(baseConfidence = 0.95): FailureDetector {
  return {
    detect(trace: Trace) {
      if (trace.spans.length === 0) return null;

      const lastSpan = trace.spans[trace.spans.length - 1];
      if (lastSpan.status !== 'error') return null;

      const errorCode = lastSpan.attributes['harness.error.code'];
      if (errorCode === HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED) {
        return {
          confidence: baseConfidence,
          evidence: `Last span "${lastSpan.name}" carried harness.error.code=${String(errorCode)}`,
          details: {
            source: 'error_code',
            code: errorCode,
          },
        };
      }

      const budgetPattern = /budget/i;
      const serializedAttributes = (() => {
        try {
          return JSON.stringify(lastSpan.attributes ?? {});
        } catch {
          return '';
        }
      })();
      const haystack = `${lastSpan.name} ${serializedAttributes}`;
      if (!budgetPattern.test(haystack)) return null;

      return {
        confidence: 0.5,
        evidence: `Last span "${lastSpan.name}" matched the fallback /budget/i heuristic`,
        details: {
          source: 'heuristic_string_match',
          match: 'budget',
        },
      };
    },
  };
}

/** Detect trace >120s with last span still running. */
function createTimeoutDetector(): FailureDetector {
  return {
    detect(trace: Trace) {
      const duration = (trace.endTime ?? trace.startTime) - trace.startTime;
      if (duration <= 120_000) return null;
      if (trace.spans.length === 0) return null;

      const lastSpan = trace.spans[trace.spans.length - 1];
      if (lastSpan.status !== 'running') return null;

      // Empirically chosen, pending validation against production data.
      // Calibrate using eval framework. Timeout detection (0.8) has moderate-high
      // confidence since long duration + running span is a strong signal.
      return {
        confidence: 0.8,
        evidence: `Trace duration ${Math.round(duration / 1000)}s with last span still running`,
      };
    },
  };
}

/** Detect ≥2 tool-related spans with error status. */
function createRepeatedToolFailureDetector(): FailureDetector {
  return {
    detect(trace: Trace) {
      const toolPattern = /tool/i;
      const errorToolSpans = trace.spans.filter(
        (s) => s.status === 'error' && toolPattern.test(s.name),
      );

      if (errorToolSpans.length < 2) return null;

      // Empirically chosen, pending validation against production data.
      // Calibrate using eval framework. Base confidence 0.5 with +0.1 per
      // error tool span, capped at 0.8.
      const confidence = Math.min(0.5 + errorToolSpans.length * 0.1, 0.8);
      return {
        confidence,
        evidence: `${errorToolSpans.length} tool-related spans with error status`,
      };
    },
  };
}

/**
 * Detect ≥minErrors error spans carrying a retryable `harness.error.code`
 * (as classified by `isRetryableHarnessErrorCode`). This bridges the
 * span-level error-code attribute written by `annotateHarnessErrorSpan`
 * with the trace-level taxonomy — a burst of `ADAPTER_RATE_LIMIT` /
 * `ADAPTER_NETWORK` / `CORE_TIMEOUT` errors in one trace is a distinct
 * failure mode from the generic `repeated_tool_failure` pattern: it
 * points at provider degradation rather than agent logic.
 */
function createAdapterRetryStormDetector(minErrors = 3): FailureDetector {
  return {
    detect(trace: Trace) {
      if (trace.spans.length === 0) return null;

      const retryableSpans = trace.spans.filter((span) => {
        if (span.status !== 'error') return false;
        const code = span.attributes['harness.error.code'];
        return typeof code === 'string' && isRetryableHarnessErrorCode(code);
      });

      if (retryableSpans.length < minErrors) return null;

      const codeHistogram: Record<string, number> = {};
      for (const span of retryableSpans) {
        const code = span.attributes['harness.error.code'] as string;
        codeHistogram[code] = (codeHistogram[code] ?? 0) + 1;
      }

      // Empirically chosen, pending validation against production data.
      // Base 0.6 with +0.05 per additional retryable error beyond minErrors,
      // capped at 0.9. Retry storms are a high-signal but noisy pattern —
      // transient upstream hiccups can trigger them without agent fault.
      const confidence = Math.min(0.6 + (retryableSpans.length - minErrors) * 0.05, 0.9);

      return {
        confidence,
        evidence: `${retryableSpans.length} error spans carrying retryable harness.error.code`,
        details: {
          source: 'error_code',
          retryableErrorCount: retryableSpans.length,
          codeHistogram,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a failure taxonomy instance for classifying agent failures from traces.
 */
export function createFailureTaxonomy(config?: FailureTaxonomyConfig): FailureTaxonomy {
  const minConfidence = config?.minConfidence ?? 0.5;
  const detectors = new Map<string, FailureDetector>();
  const stats = new Map<string, number>();

  // Register built-in detectors (using configurable thresholds where available)
  const thresholds = config?.thresholds;
  detectors.set('tool_loop', createToolLoopDetector(thresholds?.toolLoopMinRun));
  detectors.set('early_stop', createEarlyStopDetector(thresholds?.earlyStopMaxSpans));
  detectors.set('budget_exceeded', createBudgetExceededDetector(thresholds?.budgetExceededConfidence));
  detectors.set('timeout', createTimeoutDetector());
  detectors.set('repeated_tool_failure', createRepeatedToolFailureDetector());
  detectors.set(
    'adapter_retry_storm',
    createAdapterRetryStormDetector(thresholds?.adapterRetryStormMinErrors),
  );

  // Apply user-provided detectors (override by key)
  if (config?.detectors) {
    for (const [key, detector] of Object.entries(config.detectors)) {
      detectors.set(key, detector);
    }
  }

  return {
    classify(trace: Trace): readonly FailureClassification[] {
      const results: FailureClassification[] = [];

      for (const [mode, detector] of detectors) {
        const detection = detector.detect(trace);
        if (detection && detection.confidence >= minConfidence) {
          results.push({
            mode,
            confidence: detection.confidence,
            evidence: detection.evidence,
            ...(detection.details !== undefined ? { details: detection.details } : {}),
            traceId: trace.id,
          });
          stats.set(mode, (stats.get(mode) ?? 0) + 1);
        }
      }

      results.sort((a, b) => b.confidence - a.confidence);
      return results;
    },

    registerDetector(mode: string, detector: FailureDetector): void {
      detectors.set(mode, detector);
    },

    getStats(): Readonly<Record<string, number>> {
      return Object.fromEntries(stats);
    },

    reset(): void {
      stats.clear();
    },
  };
}
