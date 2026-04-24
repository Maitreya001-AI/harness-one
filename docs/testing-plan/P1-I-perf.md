# Track I · Perf baseline（P1）

**预估工时**：5 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-I -b testing/track-I-perf main
cd ../harness-one-track-I
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-I-perf`）。

**任务**：建立 perf baseline 体系。不是证明"快"，是**防回归**。5 条基线指标 + checked-in baseline JSON + CI 容忍 ±15% 漂移 gate。

### 先读

```bash
grep -rn "AgentLoop\.run\|createAgentLoop\|harness\.run" packages/core/src --include="*.ts" | head -10
find packages -name "*.bench.ts" 2>/dev/null
cat packages/core/package.json | jq '.scripts, .devDependencies'
```

### 工具选择

用 `tinybench`（轻量、无 harness 锁定）或 `vitest bench`（若 vitest 版本支持）。选一个，不要混用。推荐 `tinybench` 配合一个 120 行的 runner。

### 目录结构

```
packages/core/tests/perf/
  bench.ts                 # runner
  baseline.json            # checked-in 基线
  cases/
    agentloop-overhead.ts  # I1
    trace-span-memory.ts   # I2
    filesystem-store.ts    # I3
    stream-aggregator.ts   # I4
    guardrail-pipeline.ts  # I5
  README.md                # 怎么跑、怎么更新 baseline
```

### 5 条基线（每条独立 commit）

每条输出一个标准化 JSON 条目：`{ name, metric, unit, value, iterations, timestamp }`。

#### I1 · `AgentLoop.run()` 单迭代 overhead
- Adapter 用 `createMockAdapter`（零延迟）
- Run 一次最小 config，测 overhead（ns/iter）
- 至少 1000 次采样，report p50/p95
- **metric**: `agentloop_overhead_p50_ns` + `_p95_ns`

#### I2 · 1 万次 trace span 写入 → 内存峰值
- 用 `process.memoryUsage().heapUsed` diff
- 开一个新 traceManager，写 10k spans，force GC（`--expose-gc`）后测峰值
- **metric**: `trace_10k_span_peak_heap_mb`

#### I3 · `FileSystemStore` 在 10k entries 下 `get` / `query` 延迟
- setup：预写 10k entries 到 temp dir
- 测：随机 1000 次 `get`、100 次 `query` 的 p50 / p95
- **metric**: `fs_store_get_p50_us`、`fs_store_query_p95_ms`

#### I4 · `StreamAggregator` 处理 10MB 流总耗时
- 构造 10MB 的模拟 SSE 流（固定内容，seed 可复现）
- 测 `StreamAggregator.aggregate(...)` 从 start 到 done 总 ms
- **metric**: `stream_aggregator_10mb_total_ms`

#### I5 · Guardrail 10-guard pipeline p99
- 串 10 个 guard（一半 input、一半 output），每个做轻量字符串检查
- 跑 1000 条消息过 pipeline
- **metric**: `guardrail_pipeline_10x_p99_us`

### Runner + baseline gate

`tests/perf/bench.ts`：

```ts
// 伪代码
const results = await runAllCases(cases);
const baseline = readJson('tests/perf/baseline.json');
const drifts = compareAgainstBaseline(results, baseline, tolerance: 0.15);
if (drifts.length > 0 && !process.env.UPDATE_BASELINE) {
  console.error(drifts);
  process.exit(1);
}
if (process.env.UPDATE_BASELINE) writeJson('baseline.json', results);
```

- `pnpm bench` → 跑、对比、不更新 baseline
- `pnpm bench:update` → 跑并覆盖 baseline（owner 显式调用）
- 漂移 > +15%（慢了）即 fail；漂移 < -15%（快了）也 warn（可能是 benchmark 本身坏了）

### CI 集成

- 新增 `.github/workflows/perf.yml`
- `on: pull_request`（仅 PR 跑，不 push）
- 只在 Ubuntu + Node 20 跑（perf 数字跨 OS 差异大）
- 输出 GitHub Step Summary，含表格（case | baseline | current | diff%）
- 不覆盖 baseline.json（只在 owner 手动跑 `bench:update` 后 commit）

### File Ownership

- `packages/core/tests/perf/**`（新建）
- `packages/core/package.json`（加 scripts `bench`、`bench:update`）
- `.github/workflows/perf.yml`（新建）
- `docs/architecture/17-testing.md`（**必须更新**，新增 perf 章节）

**不要碰**：源码（若发现 perf 退化，开 issue 不改）、其他 Track 路径。

### DoD / 验收

- [ ] 5 条 case 各自独立可跑：`pnpm bench --case=I1`
- [ ] `pnpm bench` 全套 < 2 分钟
- [ ] baseline.json checked in
- [ ] 漂移 gate 实测：手动改慢一条 case（注入 sleep），CI 能检出
- [ ] Perf workflow 在 PR 上能跑通
- [ ] `docs/architecture/17-testing.md` 更新
- [ ] README.md 不改（也允许在本仓 root 加 `docs/testing-plan/perf-baseline.md` 附详细说明）

### 纪律

1. **Perf 数字只在 Ubuntu + Node 20 上对比**，其他平台仅记录
2. 不要为了让 baseline 过关**改源码**（发现退化开 issue）
3. Seeded 输入保证可重现
4. `process.memoryUsage` 测前 `global.gc?.()`（需要 `--expose-gc`）
5. 改测试层，更新 `docs/architecture/`
6. Commit 粒度：bench runner 一个、baseline.json 一个、每个 case 一个、CI workflow 一个

## ---PROMPT END---
