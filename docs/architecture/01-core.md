# Core

> Agent Loop、共享类型、错误层级——所有模块的公共基础。

## 概述

core 模块（`packages/core/src/core/`）定义了 harness-one 的共享类型契约
（Message、TokenUsage、AgentAdapter 等）、错误层级（`HarnessError` 基类
+ 5 个子类）、事件系统（`AgentEvent` 判别联合，9 个变体）、AgentLoop
工厂，以及两个跨切 port（`MetricsPort`、`InstrumentationPort`）与
`pricing` 计算。所有 L3 功能模块通过类型导入依赖 core，但 core 自身
仅依赖 `infra/`（L1 叶子层）。

## 文件结构

`AgentLoop` 由"协调骨架 + 若干专职子模块"组成。列表按职责分组：

### 生命周期协调

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/core/agent-loop.ts` | `AgentLoop` 类——持有配置/状态/指标；`run()` 仅负责编排，事件状态机委托 `iteration-coordinator` | 344 |
| `src/core/agent-loop-config.ts` | `AgentLoopConfig` 解析 + 默认值 + `MAX_STREAM_BYTES` / `MAX_TOOL_ARG_BYTES` / `MAX_TOOL_CALLS` 常量 | 170 |
| `src/core/agent-loop-types.ts` | `AgentLoopConfig` / `AgentLoopHook` / `AgentLoopStatus` 等类型声明 | 222 |
| `src/core/agent-loop-validation.ts` | 构造时数值参数校验（非正数、非有限值立即拒绝） | 79 |
| `src/core/iteration-coordinator.ts` | 事件状态机：`startRun` / `checkPreIteration` / `startIteration` / `finalizeRun`；对外 signal 清理 | 326 |
| `src/core/iteration-runner.ts` | 单轮迭代编排：adapter 调用 → 工具分发 → 护栏钩子；`bailOut` 判别联合统一终止分支 | 459 |
| `src/core/iteration-lifecycle.ts` | span + hook 生命周期（关闭 span、fire `onIterationEnd`、5 个 `bail*` 终止生成器） | 187 |
| `src/core/hook-dispatcher.ts` | `runHook` 分发器——统一 hooks 执行与 strictHooks 错误隔离 | 80 |

### Adapter 与流式

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/core/adapter-caller.ts` | 唯一的重试 + 指数退避所有者（退避委托 `infra/backoff.ts`）；按 `streaming` 分支走 `adapter.stream()` 或 `adapter.chat()`；每次调用接受 `onRetry` 回调；可选 `circuitBreaker` 配置 | 471 |
| `src/core/adapter-timeout.ts` | adapter 调用超时包装（AbortController 驱动） | 152 |
| `src/core/stream-handler.ts` | 将 `adapter.stream()` 翻译为 `AgentEvent` 流；`StreamResult` 判别联合承载错误类别 | 165 |
| `src/core/stream-aggregator.ts` | 完整的流式聚合态机——UTF-8 字节计数，供自定义 adapter `stream()` 生成器使用 | 355 |
| `src/core/streaming-retry.ts` | 单次流式尝试的 pump-and-decide 辅助 | 134 |
| `src/core/fallback-adapter.ts` | 主 adapter 失败时切换到备用；`stream()` 自动降级；并发互斥锁保护 | 171 |
| `src/core/error-classifier.ts` | `categorizeAdapterError` — 错误到类别字符串的纯函数分类（AdapterCaller 与 StreamHandler 共用） | 92 |

### 护栏钩子

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/core/guardrail-port.ts` | `GuardrailPort` 薄接口——AgentLoop 侧只依赖这个，不直接 import `/guardrails` 子系统 | 72 |
| `src/core/guardrail-runner.ts` | 三个 hook 点的 pipeline 执行、hard-block 事件合流 | 164 |
| `src/core/guardrail-helpers.ts` | `findLatestUserMessage` + `pickBlockingGuardName` 纯函数 | 47 |

### 工具执行与其它

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/core/execution-strategies.ts` | 工具执行策略：顺序 + 并行（worker pool 并发控制） | 179 |
| `src/core/tool-serialization.ts` | 工具结果的 JSON 序列化边界守卫（防止 `BigInt` / 循环引用崩溃） | 128 |
| `src/core/output-parser.ts` | `createJsonOutputParser` + `parseWithRetry` 重试（try/finally 清理定时器） | 251 |
| `src/core/conversation-pruner.ts` | `pruneConversation`——按消息数裁剪，保留开头的连续 system 消息 | 99 |
| `src/core/middleware.ts` | `createMiddlewareChain`——洋葱式 middleware 编排 | 147 |
| `src/core/resilience.ts` | `createResilientLoop`——跨迭代的外层重试壳 | 177 |
| `src/core/retry-policy.ts` | `ResiliencePolicy` 共享类型 + 默认策略构造 | 198 |
| `src/core/sse-stream.ts` | `toSSEStream` / `formatSSE` — `AgentEvent` 转 SSE 字节流 | 102 |
| `src/core/trusted-system-message.ts` | `createTrustedSystemMessage` / `isTrustedSystemMessage` / `sanitizeRestoredMessage` — SEC-A07 system-message brand | 67 |

> Mock `AgentAdapter` factories (`createMockAdapter` / `createFailingAdapter`
> / `createStreamingMockAdapter` / `createErrorStreamingMockAdapter`)
> live in `src/testing/test-utils.ts` and ship on the `harness-one/testing`
> subpath — see [`17-testing.md`](./17-testing.md). They are test doubles
> and do not appear on the production `/advanced` surface.

### 类型、错误、事件、跨切 port

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/core/types.ts` | 共享类型定义：`Message`、`AgentAdapter`、`ToolSchema`、`ExecutionStrategy` 等 | 263 |
| `src/core/errors.ts` | 5 个 `HarnessError` 子类（基类与 `HarnessErrorCode` 已下沉到 `infra/errors-base.ts`） | 106 |
| `src/core/events.ts` | `AgentEvent` 判别联合（**9 个变体**）+ `DoneReason` + `assertNever` | 68 |
| `src/core/metrics-port.ts` | `MetricsPort` 接口 + `createNoopMetricsPort` | 58 |
| `src/core/instrumentation-port.ts` | `InstrumentationPort` 薄 tracing 接口（RAG 等子系统使用） | 42 |
| `src/core/pricing.ts` | `priceUsage`、`hasNonFiniteTokens`、`ModelPricing` 计算 | 91 |
| `src/core/trace-interface.ts` | `AgentLoopTraceManager` 最小契约（AgentLoop ↔ TraceManager） | 34 |
| `src/core/index.ts` | 公共导出桶文件 | 69 |

> **历史变更**：AgentLoop 的模块分解、`HarnessError` / `HarnessErrorCode`
> 下沉到 L1、架构加固等详细记录见仓库根目录的
> [`MIGRATION.md`](../../MIGRATION.md) 与 `git log`。
> 本文件只维护当前的稳定参考。

## 公共 API

### 类型定义（节选）

| 类型 | 说明 |
|------|------|
| `Role` | `'system' \| 'user' \| 'assistant' \| 'tool'` |
| `Message` | 对话消息，含 role、content、toolCalls、meta |
| `MessageMeta` | 消息元数据：pinned、isFailureTrace、timestamp、tokens |
| `SystemMessage` / `UserMessage` / `AssistantMessage` / `ToolMessage` | role 细分的消息类型 |
| `TrustedSystemBrand` | 可信 system 消息 brand（防止 memory/session 回填被提权） |
| `ToolCallRequest` | LLM 发起的工具调用请求（id + name + arguments） |
| `TokenUsage` | 单次 LLM 调用的 token 用量（inputTokens/outputTokens；Anthropic 缓存字段见具体 adapter） |
| `AgentAdapter` | LLM 适配器接口：`chat()` 必选，`stream()` / `countTokens()` 可选 |
| `LLMConfig` | 可选 LLM 配置：temperature、topP、maxTokens、stopSequences + `extra?` 扩展字段 |
| `ResponseFormat` | 结构化输出声明 |
| `ChatParams` | `chat()` 入参：messages + tools + signal + config?（LLMConfig） |
| `ChatResponse` | `chat()` 返回：message + usage |
| `StreamChunk` | 流式响应片段：`text_delta` / `tool_call_delta` / `done` |
| `ToolSchema` | 工具的 JSON Schema 描述 |
| `JsonSchema` / `JsonSchemaType` | JSON Schema 支持子集 |
| `AgentEvent` | 9 种事件的判别联合（见下） |
| `DoneReason` | `'end_turn' \| 'max_iterations' \| 'token_budget' \| 'aborted' \| 'error'` |
| `ToolExecutionResult` | 工具批量执行的单条结果：toolCallId + result |
| `ExecutionStrategy` | 工具执行策略接口：`execute(calls, handler, options)`；可选 `dispose()` |
| `AgentLoopConfig` | AgentLoop 构造配置（含 parallel、executionStrategy、isSequentialTool） |
| `AgentLoopHook` | 生命周期 hook 接口：`onIterationStart` / `onIterationEnd` 等 |
| `AgentLoopStatus` | `'idle' \| 'running' \| 'completed' \| 'errored' \| 'disposed'` |

### AgentEvent 变体（9 个）

`iteration_start` / `text_delta` / `tool_call_delta` / `tool_call` /
`tool_result` / `message` / `warning` / `error` / `guardrail_blocked` /
`done`（实际 10 个 literal：`warning` 是 soft event，`error` 和
`guardrail_blocked` 是错误路径，其余是正常数据流）。用 `assertNever` 做
exhaustive switch。

### 错误类

| 类 | code | 触发场景 |
|----|------|---------|
| `HarnessError` | 自定义（`HarnessErrorCode` 成员） | 所有编程错误的基类（下沉到 `infra/errors-base.ts`） |
| `MaxIterationsError` | `CORE_MAX_ITERATIONS` | 循环超过 maxIterations |
| `AbortedError` | `CORE_ABORTED` | 循环被外部中止（AbortSignal 触发） |
| `ToolValidationError` | `TOOL_VALIDATION` | 工具参数校验失败 |
| `TokenBudgetExceededError` | `CORE_TOKEN_BUDGET_EXCEEDED` | 累计 token 超出预算 |
| `DisposeAggregateError` | `CORE_DISPOSE_AGGREGATE` | `disposeAll()` 聚合失败（定义在 `infra/disposable.ts`） |

> **注**：不存在 `GuardrailBlockedError` 子类——护栏拦截直接
> emit `guardrail_blocked` 事件，错误路径用 `HarnessErrorCode.GUARD_BLOCKED`
> + `GUARD_VIOLATION` 区分。请用 `err.code === HarnessErrorCode.GUARD_BLOCKED`
> 匹配而非 `err instanceof`。

`HarnessErrorCode` 是闭合字符串枚举（不再 `(string & {})` widening）。成员
用模块前缀（`CORE_*` / `TOOL_*` / `GUARD_*` / `SESSION_*` / `MEMORY_*`
/ `TRACE_*` / `ADAPTER_*` / `POOL_*` / `ORCH_*` / `LOCK_*` / `PROMPT_*`
/ `CONTEXT_*` / `RAG_*` / `EVAL_*` / `EVOLVE_*` / `CLI_*` / `PROVIDER_*` /
`STORE_*` 等）；适配器或子系统的自定义代码走 `ADAPTER_CUSTOM` +
`createCustomErrorCode(namespace, code)` escape hatch。完整枚举见
`packages/core/src/infra/errors-base.ts`。

### AgentLoop 类 + createAgentLoop 工厂

```ts
class AgentLoop {
  constructor(config: AgentLoopConfig)
  get usage(): TokenUsage
  get status(): 'idle' | 'running' | 'completed' | 'errored' | 'disposed'
  getMetrics(): { iteration: number; totalToolCalls: number; usage: TokenUsage }
  abort(): void
  dispose(): void
  async *run(messages: Message[]): AsyncGenerator<AgentEvent>
  static readonly MAX_STREAM_BYTES: number
}

// 与 harness-one 其余 `createX()` 风格对齐的工厂别名（一等 API）。
function createAgentLoop(config: AgentLoopConfig): AgentLoop;
```

两种形式等价。`new AgentLoop(...)` 给需要 subclass 访问或 `instanceof`
narrowing 的用户；`createAgentLoop(...)` 更便于中间件包装。`AgentLoop`
是 harness-one 里**唯一**继续公开导出的 class——其余所有公共原语都是
工厂（`createRegistry`、`createSessionManager`、`createTraceManager` …）。

**行为**：在循环中调用 `adapter.chat()`（或 `adapter.stream()`），如果
LLM 返回 toolCalls，则依次调用 `onToolCall` 并将结果回填，继续循环
直到 LLM 不再请求工具或触发安全阀（maxIterations / maxTotalTokens / abort）。

**非重入**：`run()` 在同一实例上并发调用会抛
`HarnessError(HarnessErrorCode.CORE_INVALID_STATE)`。模式：**每条并发请求
一个 AgentLoop 实例**，或把调用序列化。

**构造时输入验证**：`AgentLoopConfig` 中所有数值参数（`maxIterations`、
`maxTotalTokens`、`maxStreamBytes`、`maxToolArgBytes`、`toolTimeoutMs`）在
构造时校验，非正数或非有限值会立即抛出错误。

**流式安全阀**：
- `maxStreamBytes` — 单次流式响应的最大字节数；超限时中断流并抛出 `AbortedError`
- `maxToolArgBytes` — 单个工具调用参数的最大字节数；超限时跳过该工具调用并返回 `toolError('validation')`
- `maxCumulativeStreamBytes = maxIterations × maxStreamBytes` — 二级累积背stop
  防止 "每次迭代都踩 maxStreamBytes 边缘" 的组合爆破。

流字节计数器在流错误时**不重置**——累计字节数跨失败尝试保留，防止通过
重复触发短流错误绕过 `maxStreamBytes` 预算。

**生命周期状态**（`status` getter）：
- `idle` — 构造后未运行
- `running` — `run()` 正在执行中
- `completed` — `run()` 以 `end_turn` 正常结束
- `errored` — `run()` 因 abort / max_iterations / token_budget / guardrail block / adapter/tool error 结束
- `disposed` — 调用 `dispose()` 后，**优先级最高**——并发 terminal 不能把 `disposed` 覆盖回 `completed` / `errored`

**指标**（`getMetrics()`）：返回当前迭代次数、累计工具调用数和 token 用量的快照。

## 内部实现

### 循环机制

`AgentLoop.run()` 是一个 AsyncGenerator，`run()` 自身仅
负责编排：状态翻转 → `startRun()` → `while { checkPreIteration();
startIteration(); IterationRunner.runIteration(ctx) → outcome }`，最后
`finalizeRun()` 释放外部 signal 监听器。

每轮迭代内部（`IterationRunner` 负责）按以下顺序：

1. （coordinator）检查 abort 信号（单一 AbortController.signal 作为唯一真实来源）
2. （coordinator）检查 maxIterations
3. （coordinator）检查累计 token 预算（inputTokens + outputTokens 之和，非负 clamp）
4. （runner）运行输入护栏（`inputPipeline`），若硬阻则通过 `bailOut` yield `guardrail_blocked` + `error` 并 abort
5. （runner）经 `AdapterCaller.call()` 调用 adapter（按 `streaming` 分支 `stream()` 或 `chat()`）；内部实现重试 + 指数退避，每次重试回调 `onRetry` 以富化当前迭代 span
6. （runner）运行输出护栏（`outputPipeline`），若硬阻则 bailOut
7. （runner）若无 toolCalls → yield `message`，返回 `{ kind: 'terminated', reason: 'end_turn', totalUsage }`
8. （runner）若有 toolCalls → yield 所有 `tool_call` 事件，通过 `ExecutionStrategy` 执行（顺序或并行），运行 tool_output 护栏，yield 所有 `tool_result` 事件（保持原始调用顺序），将结果追加到 conversation，返回 `{ kind: 'continue' }`

`IterationRunner` 使用 `bailOut` 判别联合（`ErrorBail` / `GuardrailBail`
/ `BudgetBail` / `EndTurnBail`）统一所有终止分支的事件合流，取代过去
`run()` 中重复的 abort/span/done 三元组。

流式错误路径的错误类别由 `StreamHandler` 的 `StreamResult` 判别联合直接
承载，`AdapterCaller` 将其包装进 `AdapterCallFail.errorCategory` 返回给
runner，不再有跨方法的实例侧信道。

### 并行工具执行

AgentLoop 支持通过 `ExecutionStrategy` 接口控制工具执行方式：

- `parallel: true` → 使用 `createParallelStrategy()`（语法糖）
- `executionStrategy` → 传入自定义策略（高级用法）
- `isSequentialTool` → 回调函数，判断工具是否需要顺序执行
- `maxParallelToolCalls` → 并发上限（默认 5）

并行模式下事件顺序确定：先 yield 所有 `tool_call`，再 yield 所有
`tool_result`（按原始调用顺序）。

### 工具执行策略

| 策略 | 工厂函数 | 行为 |
|------|---------|------|
| 顺序（默认） | `createSequentialStrategy()` | 逐个执行，与原有行为一致 |
| 并行 | `createParallelStrategy({ maxConcurrency? })` | Worker pool 并发执行，`sequential` 标记的工具在并行组之后顺序执行 |

### 事件总线错误隔离

hook-dispatcher 对每个 handler 使用 try-catch 错误隔离，单个 handler 抛
异常不影响其他 handler 的执行（`strictHooks: true` 时改为重抛）。

### FallbackAdapter 流式降级

FallbackAdapter 的 `stream()` 方法支持自动降级：当底层 adapter 未实现
`stream()` 时，自动回退到 `chat()` 并将完整响应拆分为流式 chunk。

### FallbackAdapter 并发安全

FallbackAdapter 使用互斥锁保护适配器切换逻辑。并发请求同时触发降级
时，互斥锁确保只有一个请求执行适配器探测，其他请求等待结果，防止
重复探测和竞态状态翻转。

### 对话裁剪与系统消息保留

AgentLoop 在超出 token 预算时裁剪历史对话（委托
`core/conversation-pruner.ts`）。裁剪逻辑始终保留消息数组开头的所有
**连续** system 消息，无论裁剪深度如何，确保指令和角色设定不丢失。

### Errors as Feedback

工具执行异常不会中断循环，而是将错误序列化为 `{ error: message }`
回填给 LLM，让模型自行修正。

### Generator 安全

`finally` 块检测外部 `.return()` / `.throw()` 关闭，确保 `done` 事件
至少被标记，`finalizeRun()` 始终清理 signal 监听器。

### 迭代 span 富化

当构造时传入 `traceManager`，AgentLoop 会在每次迭代开始时创建
`iteration-N` span，并附着以下**可查询属性**：

| 属性 | 值示例 | 用途 |
|---|---|---|
| `iteration` | `1` | 聚合同一迭代索引的 span（工具循环识别） |
| `adapter` | `"anthropic:claude-sonnet-4"` | 按 adapter 切片延迟 / 错误率 |
| `conversationLength` | `42` | 压缩压力信号 |
| `streaming` | `false` | 区分 chat() vs stream() 路径 |
| `toolCount` | `3` | 一次迭代返回的工具调用数（工具爆炸预警） |
| `inputTokens` / `outputTokens` | `1234` / `567` | 与 cost tracker 对齐 |

**adapter 重试**：重试不再隐身——每次可重试错误触发 `adapter_retry`
span event，属性含 `attempt`、`errorCategory`、`path`（`'chat'` 或
`'stream'`），错误消息预览前 500 字符。当重试耗尽进入 error 路径时，
`errorCategory` / `error` 也写到 span 属性上再调用 `endSpan(..., 'error')`。

**工具 span 错误归因**：每个工具调用的子 span 在创建时即设 `toolName`
和 `toolCallId` 属性（不只在 span.name 字符串里），失败时再补
`errorMessage` / `errorName` 后以 `'error'` 状态关闭。trace 后端可按
`toolName` 直接聚合失败率。

## 依赖关系

- **依赖**: `infra/`（L1 叶子层）
- **被依赖**: 所有 L3 功能模块通过类型导入依赖 core

## 扩展点

- 实现 `AgentAdapter` 接口适配任意 LLM 提供商（见 `docs/provider-spec.md`）
- 通过 `ChatParams.config` 传入 `LLMConfig`（temperature、topP、maxTokens 等；`extra?: Readonly<Record<string, unknown>>` 支持 adapter 自定义参数）
- 所有数值容量限制（`maxIterations`、`maxTotalTokens` 等）均可在 `AgentLoopConfig` 中配置；非正数值在构造时被拒绝
- 通过 `onToolCall` 回调自定义工具调度逻辑
- 通过 `signal` (AbortSignal) 实现外部取消控制
- 通过 `executionStrategy` 传入自定义工具执行策略（如依赖感知、优先级调度）
- 通过 `parallel: true` 启用内置并行执行策略

## 设计决策

1. **AgentLoop 是唯一的 class 出口**——需要维护迭代状态（cumulativeUsage、AbortController），工厂函数不适合；保留类导出以支持 `instanceof` narrowing
2. **AsyncGenerator 而非回调**——调用方通过 `for await` 消费事件，天然支持背压
3. **token 非负 clamp**——`Math.max(0, ...)` 防止恶意 adapter 通过负数绕过预算检查
4. **HarnessError 层级**——每个子类携带 `.code`（程序判断）+ `.suggestion`（人类可读修复建议）
5. **Iteration coordinator 拆分**——事件状态机与 AgentLoop 解耦，便于单元测试

## 已知限制

- 累计 token 检查在调用 LLM **之前**进行，不含当次调用的 token（依赖 adapter 的 usage 上报更新累计值）
- `maxCumulativeStreamBytes` 只在流式路径上生效；`chat()` 路径依赖 adapter 自身的响应体大小限制
