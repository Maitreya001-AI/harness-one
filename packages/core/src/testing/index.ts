/**
 * Test-only subpath for `harness-one`.
 *
 * Ships mock `AgentAdapter` factories for test code that exercises the agent
 * loop without a real LLM provider. Intentionally kept off the main surface:
 *
 *   - Previously these factories were re-exported from `harness-one/advanced`
 *     alongside production extension primitives (middleware, resilient-loop,
 *     etc.). The naming misled adapter authors into thinking `createMockAdapter`
 *     was a production-ready fallback factory rather than a test double.
 *   - split them onto `harness-one/testing` so that `harness-one/advanced`
 *     carries only composable production surface, and test consumers have a
 *     clearly-named import path.
 *
 * Import from tests:
 *
 * ```ts
 * import { createMockAdapter } from 'harness-one/testing';
 * ```
 *
 * **Do not import from production code** — the contents here emit no events
 * to observability ports, skip validation paths, and are not covered by
 * semver-style stability guarantees.
 *
 * @module
 */

export type { MockAdapterConfig } from './test-utils.js';
export {
  createMockAdapter,
  createFailingAdapter,
  createStreamingMockAdapter,
  createErrorStreamingMockAdapter,
} from './test-utils.js';

export { createChaosAdapter } from './chaos/chaos-adapter.js';
export type {
  ChaosConfig,
  ChaosRecorder,
  ErrorRateConfig,
  InjectionKind,
  InjectionRecord,
} from './chaos/chaos-adapter.js';
export { createSeededRng } from './chaos/prng.js';
export type { SeededRng } from './chaos/prng.js';
