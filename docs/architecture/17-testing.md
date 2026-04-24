# Testing（`harness-one/testing`）

> 独立子路径。给**测试代码**用的 mock `AgentAdapter` 工厂集合。

## 定位

`harness-one/testing` 专门收纳 mock adapter 工厂，让用户（以及 harness
自己的测试套件）写 AgentLoop 测试时不用装配真实 LLM 客户端。

**不用于生产代码。** 这些工厂：
- 不发事件到任何 observability port。
- 跳过 validation / guardrails / pricing 等产品路径上本该生效的环节。
- 不受和 `/core` 同级的 semver 稳定性承诺——签名可能随测试场景演化收紧。

如果你正在写的是 **真实 fallback 机制**、**单测 double 以外的 adapter**、
或者 **生产下行代码**，去 `/advanced` 找 `createFallbackAdapter`，或者直接
实现自己的 `AgentAdapter`。

## 公共 API

```ts
import {
  createMockAdapter,
  createFailingAdapter,
  createStreamingMockAdapter,
  createErrorStreamingMockAdapter,
  type MockAdapterConfig,
} from 'harness-one/testing';
```

| 工厂 | 行为 |
|------|------|
| `createMockAdapter({ responses, usage? })` | 非流式 chat；按顺序返回 `responses` 的内容，末项重复；`.calls[]` 记录每次 `ChatParams` 用于断言 |
| `createFailingAdapter(error?)` | 总是抛出给定错误（或 `'Mock adapter failure'`）；用于 fallback / 错误分类测试 |
| `createStreamingMockAdapter({ chunks, usage? })` | 既有 `chat()` 又有 `stream()`；`stream()` 逐个 yield `chunks`，`chat()` 合并其中的 `text_delta` |
| `createErrorStreamingMockAdapter({ chunksBeforeError, error })` | 流式返回部分 chunks 然后抛错；用于 partial-stream 恢复测试 |

所有工厂返回的 adapter 都附带 `.calls: ChatParams[]`，按调用顺序记录每次
参数快照——用于在测试里断言"LLM 实际收到了什么"。

## 为什么单独拆一个子路径

1. **语义边界**：`/advanced` 的所有其他导出都是生产代码可以直接 import
   的扩展点（middleware、resilient-loop、fallback-adapter、SSE、execution
   strategies、backoff、trusted system message、output parser、validators、
   pricing math）。Mock adapter 是 **test double**，公开一个导出点让用户
   一眼分清楚。
2. **Tree-shake 清晰**：生产 bundle 分析时，`harness-one/testing` 的符号
   出现在运行时导入图上就是 code smell——明确信号而不是藏在 `/advanced`
   的尾部。
3. **未来扩展**：如果需要加 `createRecordedAdapter`（重放真实 trace 的
   测试 harness）或 scenario builder，这个子路径就是落地点。

## 测试

- 工厂本身的行为契约：`src/testing/__tests__/test-utils.test.ts`
- 作为依赖使用：harness 内部 ~20 个测试文件 + examples（middleware-chain /
  resilient-loop / sse-stream / multi-agent）通过 `harness-one/testing`
  消费。

## Import

```ts
import { createMockAdapter } from 'harness-one/testing';
```

## Chaos 测试

**定位**：harness-one 的差异化卖点之一是"出问题时表现正确"——fallback
adapter、resilient loop、circuit breaker、`maxStreamBytes`、guardrail
fail-closed。没有故障注入测试，这些功能等于没测。

Chaos 层专门用来在真实故障序列下验证**聚合不变量**（比如"无 span 泄漏"、
"cost 账本自洽"、"session 锁一定释放"），而不是单点行为。

### 基础设施：`createChaosAdapter`

```ts
import { createChaosAdapter } from 'harness-one/testing';

const adapter = createChaosAdapter(innerAdapter, {
  seed: 42,                     // 必传，种子决定整条注入序列
  errorRate: { 429: 0.15, 503: 0.15 },  // HTTP 级错误
  streamBreakRate: 0.2,         // 流式中途断开
  toolArgBloatRate: 0.1,        // tool_call_delta 超 `maxToolArgBytes`
  hangRate: 0.05,               // 整调用 hang，靠外部超时回收
  invalidJsonRate: 0.15,        // tool args 返非法 JSON
});
```

每项故障独立、可组合。Adapter 同时暴露：

- `.config`：原始配置回读。
- `.recorder: ChaosRecorder`：每次调用的 `InjectionRecord` 列表（`kind`、
  `path`、`callNumber`、`at`），scenario 断言时用它证明故障真的注入了。

**种子与 PRNG**。注入决策全部走 `createSeededRng()`（mulberry32，32-bit
状态，确定性），**禁止在 chaos 层使用 `Math.random`**。同一 `seed` + 同一
inner adapter + 同一调用顺序 → 位对位一致的注入记录。CI 里通过
`CHAOS_SEED` 控制种子；本地复现 flake 时只需 `CHAOS_SEED=42 pnpm test`。

### Scenario 套件（`packages/core/tests/chaos/`）

每个 scenario 跑长序列（50–200 次 run），断言**聚合**不变量：

| ID | 场景 | 注入 | 核心不变量 |
|----|------|------|------------|
| H1 | 50 run | 15%/15% 混合 429/503 | 终态可达、无 span 泄漏、cost 自洽、breaker 触发后 fallback 接管 |
| H2 | 200 stream | 20% 中途断开 | 终态可达、无 span 泄漏、所有错误落入已分类的 `HarnessErrorCode`（无 generic Error） |
| H3 | 100 stream | 10% tool_use 超限 | 超限 case 抛 `ADAPTER_PAYLOAD_OVERSIZED`，非超限 case `end_turn` |
| H4 | 100 run | 5% hang > timeout | 每次 hang 在 `1.5 × timeout` 内 abort、session 锁 100% 释放、错误码一致 |
| H5 | 100 tool | 15% 非法 JSON | 非法 JSON 走 `tool_result` 错误 envelope、`reconcileIndex()` 幂等、无半写入 |

### 聚合断言库（`tests/chaos/assertions.ts`）

Scenario 跑完调用一组通用断言：

- `assertAllRunsReachedTerminalState(runs)` — 所有 run 都发过 `done`，loop
  status 不卡在 `running`/`idle`。
- `assertNoActiveSpans(traceManager)` — `getActiveSpans()` 为空。
- `assertCostConsistency(costTracker, runs)` — recent-window 总和不超过
  per-trace cumulative 和，每条记录有限且非负。
- `assertSessionLocksReleased(sessionManager, sessionIds)` — 每个未被销毁的
  session 状态不是 `locked`。
- `assertMemoryStoreConsistent(store)` — 连续两次 `reconcileIndex()` 返回
  相同 `scanned`/`keys`，证明无悬空半写入。

### 运行

```bash
# 完整 chaos 套件（单 run 预算 <60 秒）
pnpm -F harness-one test -- chaos

# 复现 flake：固定种子复跑
CHAOS_SEED=42 pnpm -F harness-one test -- chaos

# 稳定性 sweep：10 个种子都过才算稳定
for i in {1..10}; do CHAOS_SEED=$i pnpm -F harness-one test -- chaos || break; done
```

CI 里固定种子跑一次；稳定性 sweep 由 DoD 在每次改 chaos 层时本地执行。

### 边界

- Chaos scenario **不修** harness 源码。发现真实 bug 另开 issue，scenario
  不做兜底。
- 不引入新运行时依赖；PRNG、assertion 库都在 harness 自身代码里。
- `packages/core/src/testing/chaos/**` 属于 **test-only** 子路径的扩展；
  生产 bundle 不会拉入。
