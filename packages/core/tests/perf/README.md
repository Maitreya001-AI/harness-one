# Perf baseline

Five regression-detection benchmarks that run on every pull request and
gate on **±15 % drift** versus `baseline.json`. The goal is NOT to prove
the harness is fast — it is to notice when a refactor has silently
doubled the cost of a hot path.

## Cases

| id  | metric(s)                                                   | measures                                                  |
| --- | ----------------------------------------------------------- | --------------------------------------------------------- |
| I1  | `agentloop_overhead_p50_ns`, `agentloop_overhead_p95_ns`    | Empty `AgentLoop.run()` iteration cost                    |
| I2  | `trace_10k_span_peak_heap_mb`                               | Heap held by a 10 k-span trace                            |
| I3  | `fs_store_get_p50_us`, `fs_store_query_p95_ms`              | `FileSystemStore.read` + `.query` with 2 k entries        |
| I4  | `stream_aggregator_10mb_total_ms`                           | `StreamAggregator` chewing 10 MB of 4 KB text chunks      |
| I5  | `guardrail_pipeline_10x_p99_us`                             | 10-guard pipeline (5 input + 5 output) over 1 k messages  |

See `cases/*.ts` for the exact harness wiring of each case. Every case
emits deterministic samples — inputs are seeded, temp dirs are per-run,
no network or external state.

## Running

```sh
pnpm --filter harness-one bench              # run all cases
pnpm --filter harness-one bench --case=I1    # run a single case
pnpm --filter harness-one bench:update       # overwrite baseline.json (owner-only)
```

The wrapper scripts in `package.json` set `NODE_OPTIONS=--expose-gc` so
`global.gc()` is available (I2 depends on this). When you invoke the
runner directly, do the same.

## How the gate works

1. Each case produces one or more `PerfSample` entries with
   `{ metric, unit, value, iterations, timestamp }`.
2. The runner diff's every metric against `baseline.json`:
   - `value > baseline × 1.15` → **fail** (perf regression). CI job exits
     non-zero.
   - `value < baseline × 0.85` → **warn**. Faster is not automatically
     better — sudden 20 % speedups are usually caused by a benchmark
     that stopped measuring the real thing (mock adapter that returns
     earlier, tracing disabled by accident, etc.). Investigate before
     accepting.
   - New metric not yet in the baseline → silently accepted on the
     next `bench:update` run.
3. When `UPDATE_BASELINE=1` is set, the gate is skipped and
   `baseline.json` is overwritten with the current run.

## Platforms

**`baseline.json` numbers are only meaningful on Ubuntu + Node 20.**
Filesystem, allocator, and JIT differences between hosts move some
metrics (notably I3) by 3–10×. The runner compares `process.platform +
process.version.major` against the values recorded in `baseline.json`:

- If they match, the ±15 % gate runs.
- If they differ, the current run is printed as a table but the gate is
  skipped and the GitHub Step Summary badge shows "platform mismatch".

So local runs on macOS / Windows are useful for smoke-testing case logic
and generating numbers for a conversation ("does this look sane?"), but
the numbers committed to `baseline.json` must be regenerated on the
CI image (Ubuntu + Node 20) before the gate becomes authoritative.

## Regenerating the baseline

Only the owner should run `bench:update`, and only with intent: the
baseline is a frozen contract that every PR builds against.

1. Merge the PR that changes case logic or accepts a legitimate perf
   change.
2. On an **Ubuntu + Node 20** host, run
   `pnpm --filter harness-one bench:update`.
3. Commit the new `baseline.json` in a dedicated commit whose message
   explains why the baseline moved (e.g. "bump baseline after switching
   trace-eviction policy, ~8 % heap reduction expected").
4. Push. The next CI run of `perf.yml` will be the first one measured
   against the new baseline.

## Time budget

Full suite target: **< 2 min on Ubuntu CI**.

I3 dominates wall-clock — `query()` scans every entry file in the store,
so the cost is O(entries × queries). The numbers picked (2 k entries,
20 queries) keep the case under ~5 s on Ubuntu while still exercising
the full listEntryFiles + batched readEntry + inline filter path. On
slower filesystems (macOS APFS, encrypted volumes) the same case can
take 30 s+ locally; use `--case=` to skip it during iterative
development.

I4 and I5 are sub-second on any reasonable host. I1 is effectively free
(1 k zero-delay iterations). I2 allocates ~4 MB and GCs deterministically.

## Extending

Adding a case:

1. Drop a new file under `cases/` that exports a `PerfCase` (see
   `types.ts`).
2. Register it in `CASES` in `bench.ts`.
3. Run `pnpm --filter harness-one bench:update` to admit its metrics to
   `baseline.json`.

Keep cases self-contained: seed all inputs with `createRng()` from
`helpers.ts`, never depend on wall-clock time for case logic, and emit
metrics in units (`ns`, `us`, `ms`, `mb`, …) that render sanely in the
GitHub Step Summary table.
