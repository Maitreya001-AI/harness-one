# Track H · Chaos 测试（P1）

**预估工时**：7 天（INFRA-C 2 天 + 5 scenarios 5 天）  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-H -b testing/track-H-chaos main
cd ../harness-one-track-H
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-H-chaos`）。harness-one 的差异化卖点之一是"出问题时表现正确"：fallback adapter、resilient loop、circuit breaker、`maxStreamBytes`、guardrail fail-closed。**没有故障注入测试，这些功能等于没测**。

**任务**：建立 `chaos-adapter` 基础设施 + 5 个 chaos scenario，证明**聚合不变量在故障序列下不破坏**。

### 先读

```bash
cat packages/core/src/testing/test-utils.ts | head -80
grep -rn "one-way breaker\|circuit\|backoff" packages/core/src --include="*.ts" | head -20
grep -rn "maxStreamBytes\|StreamAggregator" packages/core/src --include="*.ts" | head -10
grep -rn "reconcileIndex" packages/core/src --include="*.ts" | head -5
```

### INFRA-C · chaos-adapter wrapper（2 天）

放在 `packages/core/src/testing/chaos/`：

- `chaos-adapter.ts`: `createChaosAdapter(inner: AgentAdapter, config: ChaosConfig): AgentAdapter`
- `ChaosConfig` 支持（每项独立、可组合）：
  - `errorRate: { 429?: number; 503?: number; network?: number }` — 按概率注入 HTTP 错误
  - `streamBreakRate: number` — 流式响应中途 N% 概率断开
  - `toolArgBloatRate: number` — tool_use chunk 按 N% 概率超 `maxToolArgBytes`
  - `hangRate: number` — 整个调用按 N% 概率 hang 触发超时
  - `invalidJsonRate: number` — tool args 按 N% 返回非法 JSON
  - `seed: number` — 用 seeded PRNG 保证可重现
- 提供 `ChaosRecorder` 记录每次注入（哪次 call、注入什么），方便 scenario 断言
- 单测：每种故障模式至少一条 unit test 证明真的注入了

导出从 `packages/core/src/testing/index.ts`：`createChaosAdapter`、`ChaosConfig`、`ChaosRecorder`。

### Scenarios（每个独立 commit）

放在 `packages/core/tests/chaos/`，每个 scenario 跑**长序列**（50-200 次 run），断言**聚合不变量**：

#### H1 · 50 次 run × 30% 429/503 混合
- 配 retry + fallback + one-way breaker
- 聚合不变量：
  - 所有 run 最终进入终态（无卡在非终态）
  - `traceManager.activeSpans.length === 0`（无 span 泄漏）
  - `costTracker.total === sum(每个 trace.cost)`
  - breaker 触发时间点前后行为正确（前 retry、后直接 fallback）

#### H2 · 流式响应中途断开（20%）
- 200 次 stream run，每次有 20% 概率中途 `throw`
- 聚合不变量：
  - `StreamAggregator` 的 byte counter 跨重试不重置
  - 所有最终 error 都正确分类（不是 generic Error）
  - 无 file descriptor / buffer 泄漏（check heap snapshot diff）

#### H3 · tool_use chunk 超 `maxToolArgBytes`
- 100 次 tool-heavy run，10% 概率注入超大 tool args
- 聚合不变量：
  - 100% 超限 case 抛 `ToolArgLimitExceeded`（或等价）
  - 未超限 case 正常完成
  - guardrail 事件按预期触发（如果架构将此绑定到 guardrail）

#### H4 · 整调用 hang（5%）+ timeout 配置
- 100 次 run，5% 概率让调用 hang > timeout
- 聚合不变量：
  - 所有 hang 都在 `timeout` 内被 abort（实测 elapsed < timeout * 1.5）
  - `AbortedError` 语义一致
  - `session.lock` 在 abort 后 100% 释放（无死锁）

#### H5 · 非法 JSON tool args（15%）
- 100 次 tool run，15% 返回非法 JSON
- 聚合不变量：
  - 100% 非法 case 走 `toolError` 事件（不是 unhandled parse error）
  - `memoryStore` 没有记录任何半写入的 state
  - 调用 `reconcileIndex()` 返回空 diff

### 聚合断言库

`packages/core/tests/chaos/assertions.ts`：

- `assertNoActiveSpans(traceManager): void`
- `assertCostConsistency(costTracker, traces): void`
- `assertSessionLocksReleased(sessionManager): void`
- `assertMemoryStoreConsistent(store): Promise<void>`（调 `reconcileIndex` 断言无 diff）
- `assertAllRunsReachedTerminalState(runs): void`

每个 scenario 跑完调一组。

### File Ownership

- `packages/core/src/testing/chaos/**`（新建）
- `packages/core/src/testing/index.ts`（加 export）
- `packages/core/src/testing/__tests__/chaos-adapter.test.ts`（新建）
- `packages/core/tests/chaos/**`（新建）
- `docs/architecture/17-testing.md`（**必须更新**，新增 chaos 章节）

**不要碰**：`packages/core/src/core/**`、`packages/core/src/infra/**`、其他 Track 路径（包括 D track 的集成测试）。

### DoD / 验收

- [ ] INFRA-C 单测全绿，每种故障模式注入有单独证明
- [ ] 5 个 scenario 全绿
- [ ] 每个 scenario 跑 3 轮 100% 稳定（不同 seed 都过）
- [ ] 聚合断言库被多个 scenario 复用
- [ ] 无 flaky：`for i in {1..10}; do CHAOS_SEED=$i pnpm test -- chaos || break; done` 10 次全过
- [ ] `docs/architecture/17-testing.md` 更新
- [ ] 跑完一轮完整 chaos 套件 < 60 秒（单机），不拖累 CI

### 纪律

1. **不要**改 harness 源码来"修"发现的问题——发现 bug 单独 issue
2. 改 `packages/core/src/testing/` 涉及测试层架构，必须更新 `docs/architecture/`
3. 不引入新运行时依赖
4. Seeded PRNG 保证可重现（`seed` 参数必传，CI 固定 seed）
5. Commit 粒度：INFRA-C 一个，每个 scenario 一个

## ---PROMPT END---
