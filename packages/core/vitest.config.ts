import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files live in two roots: `src/**/*.test.ts` for unit tests colocated
    // with the code under test, and `tests/**/*.test.ts` for higher-layer
    // scenarios that compose real subsystems. `tests/` covers
    // `tests/integration/` (Track D cross-subsystem invariants),
    // `tests/chaos/` (scenario files that exercise the chaos adapter across
    // 50–200 runs per scenario and stay under the suite-wide 60s budget),
    // and `tests/security/` (adversarial coverage of the redact pipeline).
    // All three are documented in `docs/architecture/17-testing.md`.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // vitest 4 expanded the default `vi.useFakeTimers()` toFake set to
    // include `setImmediate`/`queueMicrotask`/`nextTick`, which collides
    // with vitest's own internal hook scheduling and made every
    // `useFakeTimers()`-based suite (rate-limiter, session GC, circuit
    // breaker, agent-pool, etc.) hang in afterEach with
    // "Hook timed out in 10000ms". Pin the safe minimal set project-wide
    // so individual tests don't have to remember to opt out of microtask
    // / immediate / nextTick faking. Tests that genuinely need to fake
    // those types must override `toFake` at the call site.
    fakeTimers: {
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
        'performance',
      ],
    },
    // vitest 4 worker rpc + coverage instrumentation has a race where a
    // console.log fired from inside a fake-timer callback (e.g., the
    // `safeWarn` fallback inside tools/registry.ts's non-responsive-tool
    // detector) can land on `onUserConsoleLog` after the worker rpc has
    // begun closing, surfacing as
    // "EnvironmentTeardownError: Closing rpc while 'onUserConsoleLog' was
    // pending" — surfaced as `Errors 1 error` after all 3729 tests pass and
    // failed every cross-platform `build` job in CI even though tests
    // themselves were green. Disabling vitest's console intercept dodges the
    // race entirely; logs still print to the terminal (just not captured
    // into the reporter buffer per-test). Tests that need console
    // assertions use `vi.spyOn(console, …)` directly, so no test loses
    // capability from this flip.
    disableConsoleIntercept: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
