# Advanced

> 扩展点桶。框架作者、适配器实现者、定制 loop 构建者的低阶原语。刻意与
> `harness-one/core` 的端用户表面分离。

## 定位

`harness-one/core` 是稳定的、狭窄的终端用户表面（典型调用方所需的那套：
`createAgentLoop`、hooks、错误、消息类型、pricing、两个 tracing port）。
`harness-one/advanced` 是所有"低阶积木"——暴露给高级调用方去组合，但
**契约的稳定性弱于 core**：随着内部重构，签名可能收紧。

生产代码能从 `/core` 拿到的原语就从 `/core` 拿；只有实现适配器、定制执行
策略、搭建 SSE 网关等"把 harness 当 SDK 用"的场景才会落到这里。

## 文件结构

这个子系统不拥有任何自己的实现文件——它只是一个**再导出桶**，从 `core/` 和
`infra/` 两个下层的源头聚合。因此所有的实现和测试都挂在源文件上；本子路径没有
独立的 `__tests__` 目录。

| 区域 | 导出文件来源 | 用途 |
|------|-------------|------|
| Middleware 编排 | `core/middleware.ts` | `MiddlewareChain`, `createMiddlewareChain`, `MiddlewareContext`, `MiddlewareFn` |
| Trace 接口 | `core/trace-interface.ts` | `AgentLoopTraceManager`（AgentLoop 与 TraceManager 的最小契约） |
| Adapter 流限额 | `core/agent-loop-config.ts` | 常量 `MAX_STREAM_BYTES` / `MAX_TOOL_ARG_BYTES` / `MAX_TOOL_CALLS`——adapter 侧默认与核心对齐 |
| 流聚合器 | `core/stream-aggregator.ts` | `StreamAggregator`（自定义 adapter `stream()` 用的完整态机） |
| 输出解析 | `core/output-parser.ts` | `createJsonOutputParser`, `parseWithRetry`, `OutputParser` |
| Fallback 适配器 | `core/fallback-adapter.ts` | `createFallbackAdapter`, `FallbackAdapterConfig` |
| SSE 辅助 | `core/sse-stream.ts` | `toSSEStream`, `formatSSE`, `SSEChunk` |
| 执行策略 | `core/execution-strategies.ts` | `createSequentialStrategy`, `createParallelStrategy` |
| 错误分类 | `core/error-classifier.ts` + `core/errors.ts` | `categorizeAdapterError`, `createCustomErrorCode`, `HarnessErrorDetails` |
| 对话裁剪 | `core/conversation-pruner.ts` | `pruneConversation`, `PruneResult` |
| Resilient loop | `core/resilience.ts` + `core/retry-policy.ts` | `createResilientLoop`, `ResilientLoopConfig`, `ResilientLoop`, `ResiliencePolicy` |
| 验证 + pricing | `infra/validate.ts` + `core/pricing.ts` | `requirePositiveInt` / `requireNonNegativeInt` / `requireFinitePositive` / `requireFiniteNonNegative` / `requireUnitInterval` / `validatePricingEntry` / `validatePricingArray` / `priceUsage` / `hasNonFiniteTokens` / `PricingNumericFields` |
| Backoff | `infra/backoff.ts` | `computeBackoffMs`, `computeJitterMs`, `createBackoffSchedule`, 两个 jitter 常量 |
| 可信系统消息 | `core/trusted-system-message.ts` | `createTrustedSystemMessage`, `isTrustedSystemMessage`, `sanitizeRestoredMessage` |

> Mock `AgentAdapter` 工厂（`createMockAdapter` / `createFailingAdapter`
> / `createStreamingMockAdapter` / `createErrorStreamingMockAdapter`）
> 不在此路径——它们是 test doubles，住在独立的 `harness-one/testing`
> 子路径，见 [`17-testing.md`](./17-testing.md)。

## 为什么要单独一个子路径

1. **语义分层**：`/core` = 端用户；`/advanced` = 扩展点。命名上就区分出
   "给调用方" 与 "给扩展作者"。
2. **弱化契约承诺**：`/advanced` 的符号稳定性弱于 `/core`——重构时允许
   优先收紧内部 API。`MIGRATION.md` 会记录 `/advanced` 的 break change。
3. **tree-shake 友好**：只用 `/core` 的用户不会被 `/advanced` 的原语拖累。
4. **避免根桶爆炸**：`createResilientLoop` / `createMiddlewareChain` 在
   根桶保留 value 导出，其余扩展原语统一从 `/advanced` 获取，让根桶
   停留在 18 个精选值符号。`createSecurePreset` 因循环风险不放在根桶，
   从 `@harness-one/preset` 导入。

## 公共 API 快速索引

### `createMiddlewareChain(middlewares, terminal)`
洋葱式 middleware 编排。Context 含 adapter / config / tools / signal；
terminal 通常是 `adapter.chat`。

### `StreamAggregator`
自定义 adapter `stream()` 用的累积态机——把逐 chunk 的 delta 合并成
`{ message, usage }`，同时产出 `delta` / `done` / `error` 事件。默认
按 UTF-8 字节计数，与 `maxStreamBytes` / `maxToolArgBytes` 一致。

### `createJsonOutputParser` + `parseWithRetry`
把 LLM 非结构化输出转 JSON 的 parser + 失败重试循环（同源 adapter）。

### `createFallbackAdapter({ primary, fallbacks, shouldFailover })`
主适配器失败时切换到备用。`stream()` 支持自动降级（底层 adapter 无
`stream()` 时拆 `chat()` 响应为流式 chunk）。内部互斥锁保护切换逻辑，
并发降级请求只会触发一次探测。

### `toSSEStream(events)` / `formatSSE(chunk)`
把 `AgentEvent` 流转为 SSE 字节流。`toSSEStream` 自动处理
`retry:` / `id:` / `event:` / `data:` 字段；调用方按需透传给 HTTP 响应。

### `createSequentialStrategy()` / `createParallelStrategy({ maxConcurrency? })`
工具执行策略工厂。传入 `AgentLoopConfig.executionStrategy` 或用
`parallel: true` 的语法糖。

### `categorizeAdapterError(err)`
把任意 adapter 抛的错误归类到 `ADAPTER_AUTH` / `ADAPTER_RATE_LIMIT` /
`ADAPTER_NETWORK` / `ADAPTER_BAD_REQUEST` / `PROVIDER_ERROR` /
`ADAPTER_UNKNOWN`。`AgentLoop` 用它决定是否重试。

### `createResilientLoop({ loopFactory, policy })`
外层重试壳——`loopFactory` 每次被调用都返回新的 `AgentLoop` 实例，
policy 决定重试次数 / 退避 / 可恢复错误集合。适合处理**跨迭代**的
persistent failure（例如连续 OOM / rate-limit）。

### `pruneConversation(messages, { maxMessages, preserveSystem })`
按消息数裁剪历史。自动保留开头的连续 system 消息；裁剪点落在 user/tool
消息边界。AgentLoop 用它处理 `maxConversationMessages`。

### `require*` + `validatePricing*`
数值边界守卫。`requirePositiveInt` 拒绝分数、NaN、Infinity、零、负数；
`validatePricingArray` 把 pricing 项逐个过 `validatePricingEntry`。
preset 的配置校验、circuit-breaker / execution-strategies 的内部检查
都用这些。

### `computeBackoffMs` / `createBackoffSchedule`
确定性退避计算。所有 jitter 落在 [0, ADAPTER_RETRY_JITTER_FRACTION]
或 [0, AGENT_POOL_IDLE_JITTER_FRACTION] 的比例内——生产与测试共享
同一套常量。

### `createTrustedSystemMessage(text)`
构造带 `TrustedSystemBrand` 的 system 消息。恢复路径上没有此 brand 的
system 消息会被降级为 `user`，防止 memory/session 回填被提权为 prompt
指令。

### Test utilities（不在此路径）
Mock `AgentAdapter` 工厂住在独立的 `harness-one/testing` 子路径——
它们是测试 double，不应出现在生产 import 图里。详见
[`17-testing.md`](./17-testing.md)。

## 依赖关系

- **依赖**：`core/`、`infra/`。
- **被依赖**：所有 L4 适配器（anthropic / openai / ...）、preset、devkit、
  examples。调用方不直接 `import` 到实现文件；只走 `harness-one/advanced`
  的公共路径。

## 设计决策

1. **只聚合，不实现**：避免把稳定契约和实验性符号搅在一起。每个 export
   都是对 `core/` 或 `infra/` 源文件的再导出，本模块不增加任何 LOC 的
   实现负担。
2. **`/advanced` 契约弱于 `/core`**：`MIGRATION.md` 记录 break change，但
   不保证 0.x / 1.x 跨版本兼容。
3. **Test utilities 不在这里**：mock adapter 工厂住在
   `harness-one/testing` 子路径。理由：`/advanced` 的其他导出都是生产
   代码能安全组合的原语（middleware、resilient-loop、fallback、SSE），
   而 mock 工厂是 test doubles — 混在一起让 adapter 作者误读为"生产
   级 fallback"。详见 [`17-testing.md`](./17-testing.md)。
