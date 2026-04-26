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

// Slow mock adapter — deterministic delays so abort/timeout scenarios
// are observable in tests without real network. Closes showcase 04
// `Cascade abort scenario didn't trigger`.
export type { SlowMockAdapterConfig } from './slow-mock-adapter.js';
export { createSlowMockAdapter } from './slow-mock-adapter.js';

// Crashable subprocess spawner — recognises SIGKILL even when laundered
// through pnpm/tsx wrappers (exit code 137). Closes showcase 03
// `SIGKILL via pnpm wrapper surfaces as exit code 137`.
export type {
  SpawnCrashableConfig,
  SpawnCrashableOutcome,
} from './spawn-crashable.js';
export { spawnCrashable } from './spawn-crashable.js';

// Temp checkpoint dir helper — closes coding-agent HC-017
// (`checkpointDir is the only seam for sandboxing tests`).
export type { WithTempCheckpointDirOptions } from './temp-checkpoint.js';
export { withTempCheckpointDir } from './temp-checkpoint.js';

// Chaos adapter — seeded fault injection for long-running scenarios.
// See `docs/architecture/17-testing.md` § Chaos 测试.
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

// Cassette fixtures — record real adapter I/O once, replay in contract
// tests. See `docs/architecture/17-testing.md` for the full layer
// description.
export {
  createCassetteAdapter,
  recordCassette,
  loadCassette,
  computeKey,
  fingerprint,
  isCassetteEntry,
  SUPPORTED_VERSIONS,
  type CassetteChatEntry,
  type CassetteEntry,
  type CassetteRequestFingerprint,
  type CassetteReplayOptions,
  type CassetteStreamEntry,
  type CassetteVersion,
} from './cassette/index.js';

// Adapter contract suite — share a single set of ~25 AgentAdapter
// assertions across every adapter implementation.
export {
  CONTRACT_FIXTURES,
  cassetteFileName,
  contractFixturesHandle,
  createAdapterContractSuite,
  type AdapterContractSuiteOptions,
  type ContractAdapterFixturesHandle,
  type ContractFixture,
  type ContractFixtureExpectations,
} from './contract/index.js';
