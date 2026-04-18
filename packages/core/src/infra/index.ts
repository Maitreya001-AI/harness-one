/**
 * `harness-one/infra` — infrastructural primitives for admission control and
 * long-lived timer hygiene.
 *
 * The module exposes a **curated** slice of `src/infra/`: anything not listed
 * here (errors, logger, LRU, brands, etc.) stays private to core and is not
 * part of the public contract. Callers that need those must import from
 * `harness-one/core` or the specific L3 subpath that re-exports them.
 *
 * @module
 */

export {
  createAdmissionController,
  type AdmissionController,
  type AdmissionControllerConfig,
  type AcquireOptions,
  type AdmissionPermit,
} from './admission-controller.js';

export {
  unrefTimeout,
  unrefInterval,
  type UnrefTimer,
} from './timers.js';
