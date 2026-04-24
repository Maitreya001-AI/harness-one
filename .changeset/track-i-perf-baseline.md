---
"harness-one": patch
---

Add Track I perf baseline suite under `packages/core/tests/perf/` — five
regression-detection benchmarks gated at ±15% drift per PR:

- I1 `AgentLoop.run()` single-iteration overhead (p50/p95 ns).
- I2 10k trace-span heap peak (mb).
- I3 `FileSystemStore` `read` p50 + `query` p95 over 2k entries.
- I4 `StreamAggregator` 10 MB throughput (ms).
- I5 10-guard pipeline p99 over 1k messages (µs).

Numbers live in `packages/core/tests/perf/baseline.json`; the runner
(`pnpm --filter harness-one bench`) diffs against them and fails the
job on >+15% regression or warns on <-15% (likely benchmark broke).
`pnpm --filter harness-one bench:update` rewrites the baseline and is
owner-only — `.github/workflows/perf.yml` diff-guards the file during
CI so it cannot drift silently.

Baseline is currently a darwin placeholder — a platform-match check
in the runner skips the gate on any OS/Node-major mismatch, so Ubuntu
CI will stay green until the owner regenerates on Ubuntu + Node 20.

Pure dev tooling: `tinybench` 6.0 and `tsx` 4.19 as devDeps, no
runtime bundle impact. See `docs/architecture/17-testing.md` for the
design write-up and `packages/core/tests/perf/README.md` for the
runbook.
