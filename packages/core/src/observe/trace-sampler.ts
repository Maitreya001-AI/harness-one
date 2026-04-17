/**
 * Head-based trace sampler.
 *
 * Extracted from `trace-manager.ts` in round-3 cleanup. The sampler owns the
 * runtime-mutable `samplingRate`, validation, and the per-trace sampling
 * decision snapshot. Keeping the state on its own object makes it impossible
 * for the trace-manager core to flip the rate without going through validation.
 *
 * The sampling decision is snapshotted at `startTrace()` time so that a later
 * `setSamplingRate()` call does not change the export verdict for a still-in-
 * flight trace — existing invariant, preserved verbatim here.
 *
 * @module
 */

import { randomInt } from 'node:crypto';
import { HarnessError, HarnessErrorCode } from '../core/errors.js';

/** Runtime-mutable head sampler over a default rate in `[0, 1]`. */
export interface TraceSampler {
  /** Decide whether a trace started NOW should be sampled. */
  decide(): { readonly rateSnapshot: number; readonly sampled: boolean };
  /** Replace the runtime sampling rate; throws on invalid input. */
  setRate(rate: number): void;
  /** Read the current runtime sampling rate. */
  getRate(): number;
}

/**
 * Build a sampler over `defaultRate` (defaults to 1 — export everything).
 *
 * Throws `CORE_INVALID_CONFIG` when `defaultRate` is outside `[0, 1]` or not
 * finite, matching the behaviour previously inlined in `createTraceManager`.
 */
export function createTraceSampler(defaultRate = 1): TraceSampler {
  if (!Number.isFinite(defaultRate) || defaultRate < 0 || defaultRate > 1) {
    // Config-level field name so the error surfaces the knob the caller set.
    throw new HarnessError(
      'defaultSamplingRate must be a finite number in [0, 1]',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a rate between 0 and 1 inclusive',
    );
  }
  let samplingRate = defaultRate;

  function decide(): { rateSnapshot: number; sampled: boolean } {
    const rateSnapshot = samplingRate;
    const sampled =
      rateSnapshot >= 1 || randomInt(0, 1 << 30) / (1 << 30) < rateSnapshot;
    return { rateSnapshot, sampled };
  }

  function setRate(rate: number): void {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new HarnessError(
        'samplingRate must be a finite number in [0, 1]',
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Provide a rate between 0 and 1 inclusive',
      );
    }
    samplingRate = rate;
  }

  function getRate(): number {
    return samplingRate;
  }

  return { decide, setRate, getRate };
}

