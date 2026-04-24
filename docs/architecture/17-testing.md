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

## 跨子系统集成测试层（`packages/core/tests/integration/`）

**目的**：harness-one 的单测（4500+）逐模块覆盖很好，但**单测和 E2E 之间
缺少一层"两到三个 subsystem 拼起来能跑"的证据**。这一层就在补这个空
白——每个 scenario 把真实 subsystem 装在一起跑，**只 mock LLM
adapter**（通过 `harness-one/testing` 的 `createMockAdapter` /
`createFailingAdapter`），其它 harness 代码都是真货。

Vitest 的 `include` glob 在 `packages/core/vitest.config.ts` 里已经扩到
`tests/**/*.test.ts`，所以新文件直接被 pick 上。共享 fixtures 放在
`tests/integration/fixtures/`（目前是 `temp-dirs.ts` 的 `useTempDir()` +
`mock-llm-responses.ts` 的 `textResponse` / `toolCallResponse` 辅助
函数）。

### 已实现的 scenario（Track D，P0）

| 文件 | 联合模块 | 固守的不变量 |
|------|----------|----------------|
| `agentloop-trace-cost.test.ts` (D1) | AgentLoop + TraceManager + CostTracker + tools registry | 四个口径（`AgentLoop.usage` / `done.totalUsage` / 逐 iteration span 的 token attrs / CostTracker 记录）在一次 run 里必须完全一致；tool span 的 `parentId` 必须指向同 iteration 的 iteration span |
| `guardrails-fail-closed.test.ts` (D2) | AgentLoop + GuardrailPipeline（input / tool_output / output 三个 hook 点） | input 块 → `guardrail_blocked` → `error` → `done(error)` 三段顺序稳定，adapter 未被调用；tool_output 块把结果重写为 `GUARD_VIOLATION` 桩，loop 继续 `end_turn`；output 块在最终回答阶段同 input；同一个 pipeline 在下一个 fresh loop 上的干净 run 必须没有任何污染 |
| `tools-parallel-error.test.ts` (D3) | AgentLoop + parallel ExecutionStrategy + tools registry | 三个并行 tool 里一个抛错，另外两个正常返回；worker pool 不卡；tool_result 事件顺序 = 原始调用顺序；抛错的 tool 通过 registry 的 `ToolFeedback` 结构化包裹（不是 uncaught）；loop 进入下一个 adapter turn 且没有顶层 `error` 事件 |
| `fallback-retry.test.ts` (D4) | AgentLoop adapter-retry + `createFallbackAdapter` + backoff | (a) 可重试 429 触发 `maxAdapterRetries` 次 `adapter_retry` span 事件，每次 `backoff_ms` 落在 `createBackoffSchedule` 同参数下的上下界里；(b) fallback adapter 配 `maxFailures: 1` 一次触发后变单向——后续 run 直接走备份 |
| `session-memory-relay.test.ts` (D5) | SessionManager + filesystem MemoryStore + ContextRelay | session TTL 过期抛 `SESSION_EXPIRED`，但磁盘上 relay 状态独立存活，新 relay 实例可加载到最后 checkpoint；`_index.json` 被 garbage bytes 破坏后 `query()` 仍能走 `listEntryFiles()` 返回所有 entry，`reconcileIndex()` 以"latest updatedAt wins per key"策略重建，之后 `write()` 再次 work |

### 纪律

- **不 mock harness 自家代码**。只 mock LLM adapter。任何想 mock trace
  manager / cost tracker / session / memory 的冲动都说明 scenario 粒度
  错了——拆更小或换更合适的 fixture，不要加 mock。
- **每个文件 < 200 行，单一责任**。一个 scenario 一个文件，描述一组紧密
  相关的不变量。
- **断言窄**。`it('accumulates cost monotonically across parallel tool
  calls')` 而不是 `it('works')`；不变量命名化，失败信号精确。
- **不吞错**：禁止 `try / catch + expect(true)` 模式。要么让错误真正抛出，
  要么显式 capture 并断言类型 + code。
- **文件所有权**：这一层只在 `packages/core/tests/integration/` 和
  `packages/core/vitest.config.ts`（如果需要扩 glob）工作。发现真实
  bug（非测试问题）时不擅自改源码，单独开 issue / 在 PR 里 flag 给
  owner。

## Import

```ts
import { createMockAdapter } from 'harness-one/testing';
```
