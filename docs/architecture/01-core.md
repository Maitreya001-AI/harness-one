# Core

> Agent Loop、共享类型、错误层级——所有模块的公共基础。

## 概述

core 模块定义了 harness-one 的共享类型契约（Message、TokenUsage、AgentAdapter 等）、统一错误层级（HarnessError 及其子类）、事件系统（AgentEvent 判别联合），以及唯一的 class：`AgentLoop`。所有功能模块通过类型导入依赖 core，但 core 自身仅依赖 `_internal/`。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/core/types.ts` | 共享类型定义：Message、AgentAdapter、ToolSchema、ExecutionStrategy 等 | ~130 |
| `src/core/errors.ts` | HarnessError 基类 + 5 个子类 | ~135 |
| `src/core/events.ts` | AgentEvent 判别联合 + DoneReason | ~30 |
| `src/core/agent-loop.ts` | AgentLoop 类——生命周期/状态/指标所有者；`run()` 现为 65 行协调骨架（见 Wave-5B 分解） | ~845 |
| `src/core/iteration-runner.ts` | 单轮迭代编排：adapter 调用 → 工具分发 → 护栏钩子；`bailOut` 判别联合统一终止分支 | ~660 |
| `src/core/adapter-caller.ts` | 唯一的重试 + 指数退避所有者（退避逻辑委托 `infra/backoff.ts`）；按 `streaming` 分支走 `adapter.stream()` 或 `adapter.chat()`；每次调用接受 `onRetry` 回调；可选 `circuitBreaker` 配置实现快速失败 | ~400 |
| `src/core/stream-handler.ts` | 将 `adapter.stream()` 翻译为 `AgentEvent` 流；返回 `StreamResult` 判别联合（承载错误类别，消除原 `_lastStreamErrorCategory` 侧信道） | ~161 |
| `src/core/guardrail-helpers.ts` | `findLatestUserMessage` + `pickBlockingGuardName` 纯函数 | ~52 |
| `src/core/execution-strategies.ts` | 工具执行策略：顺序 + 并行（worker pool 并发控制） | ~100 |
| `src/core/error-classifier.ts` | `categorizeAdapterError` — 错误到类别字符串的纯函数分类（AdapterCaller 与 StreamHandler 共用） | — |
| `src/core/output-parser.ts` | JSON 输出解析器 + `parseWithRetry` 重试（定时器已修复 `try/finally` 清理） | ~218 |
| `src/core/index.ts` | 公共导出桶文件 | ~38 |

### Wave-5B AgentLoop 模块分解（2026-04-15）

`agent-loop.ts` 原为 1268 LOC，`run()` 方法约 600 LOC 同时承担迭代控制、adapter 调用、流式翻译、重试退避、护栏钩子、span 埋点与钩子派发。Wave-5B 将其拆为 4 个协作模块，`run()` 收缩为 65 行编排骨架，实例上的 `_lastStreamErrorCategory` 侧信道被删除。

| 模块 | 职责 | 所有状态 | 对外导出 |
|------|------|---------|---------|
| `AgentLoop`（`agent-loop.ts`） | 实例生命周期、`status` / `usage` / `getMetrics()`、`run()` 编排、外部 signal 桥接、non-reentrancy 保护 | `_status` / `_iteration` / `cumulativeUsage` / `_totalToolCalls` / `abortController` | `AgentLoop` 类、`createAgentLoop` 工厂、`AgentLoopConfig` / `AgentLoopHook` / `AgentLoopTraceManager` 类型 |
| `IterationRunner`（`iteration-runner.ts`） | 单轮迭代：pre-iteration 预检（abort / max-iterations / token budget 由 orchestrator 处理后调用）、输入护栏、adapter 调用、工具分发、输出护栏、`bailOut` 终止事件合流 | **无**——每次运行由 orchestrator 分配 `IterationContext`；runner 本身是无状态工厂产物 | `createIterationRunner`、`IterationContext`、`IterationRunnerConfig`、`IterationOutcome`、`IterationRunner` 类型 |
| `AdapterCaller`（`adapter-caller.ts`） | 一次 adapter turn（`chat` 或 `stream`），内部实现重试 + 指数退避；将错误归一为 `AdapterCallResult` 判别联合 | 无（每次 `call()` 内部闭包） | `createAdapterCaller`、`AdapterCallOk` / `AdapterCallFail` / `AdapterCallResult`、`AdapterRetryInfo`、`AdapterCallerConfig`；`callOnce` 单次非重试入口保留 |
| `StreamHandler`（`stream-handler.ts`） | 消费 `adapter.stream()`、逐块 yield `text_delta` / `tool_call_delta` / `warning` / `error`、在失败前 yield `error` 事件再返回 `{ ok: false, errorCategory }` | 跨 `handle()` 无状态；每次 `handle()` 内新建 `StreamAggregator` | `createStreamHandler`、`StreamResult` 判别联合、`StreamHandlerConfig`、`StreamHandler` 类型 |
| `guardrail-helpers.ts` | 纯辅助：从消息数组取最新用户消息、从 `GuardrailResult` 选出导致阻塞的 guard 名称 | 无 | `findLatestUserMessage` / `pickBlockingGuardName` 函数 |

**设计约束（来自 ADR）**：

- `AdapterCaller` 是唯一重试所有者——`IterationRunner` 不再内联重试循环。
- `StreamHandler` 的 `StreamResult` 判别联合承载 `errorCategory` 字段，直接替代过去写到 `AgentLoop._lastStreamErrorCategory` 的实例侧信道；路径上恰好 yield 一次 `{ type: 'error' }` 事件（`AdapterCaller` 不再重复 yield）。
- `IterationRunner` 接收 orchestrator 分配的 `IterationContext`（conversation、iteration counter、cumulativeUsage、cumulativeStreamBytes、toolCallCounter 等可变 box），每次 `runIteration()` 后 `AgentLoop.run()` 把 context 字段回写到实例字段，保证 `getMetrics()` / `usage` getter 行为不变。
- `ExecutionStrategy.execute()` 的 `options` 收紧为 `Readonly<>`，允许 `AgentLoop` 在构造期冻结一次、每轮复用同一引用（PERF-025）。
- 原静态方法 `AgentLoop.categorizeAdapterError` 删除；`categorizeAdapterError` 作为具名导出由 `error-classifier.ts` 提供（`harness-one/core` 继续导出此符号）。

**公共 API 变更**：无。所有模块拆分对 `AgentLoop` / `createAgentLoop` / `AgentLoopConfig` / `AgentEvent` 等消费侧导出保持行为与签名不变；纯内部重构。

**设计文档**：`docs/forge-fix/wave-5/wave-5b-adr-v2.md`（设计决策与边界论证）、`wave-5b-adr-critique.md` / `wave-5b-review-redteam.md` / `wave-5b-review-synthesis.md`（评审记录）。

### Wave-5H 架构加固（2026-04-16）

对全代码库进行深度架构审查后的 23 项修复：

**输入验证**：
- `createParallelStrategy` 验证 `maxConcurrency >= 1`（防死锁）。
- `createCircuitBreaker` 验证 `failureThreshold >= 1` 和 `resetTimeoutMs >= 1`。
- `createFallbackAdapter` 拒绝空适配器数组。
- `pruneConversation` 安全处理 `maxMessages < 1`。
- `computeBackoffMs` 对负数 `attempt` 夹紧为 0。

**生产就绪**：
- `TraceManager` 中所有 `console.warn` 回退已移除——库代码不再直接写 stderr。导出错误路由到注入的 `logger` 或 `onExportError`；两者都缺失时静默吞咽。
- `CostTracker.alertHandlers` 从 Array 改为 Set（O(1) 退订，与 session/orchestrator 一致）。
- 护栏管线超时定时器增加 `.unref()` 防止进程挂起。

**并发安全**：
- `FallbackAdapter.handleSuccess()` 现在在 `switchLock` 内执行（防止与并发 failure 竞争）。
- `createParallelStrategy` 在每个工具调用前检查 abort signal。

**API 一致性**：
- `SessionManager.list()` 不再返回已过期会话（之前泄露内部状态）。
- `SessionManager.activeSessions` 简化为 O(1)。
- `RAGPipeline.clear()` 同步重置 `getIngestMetrics()` 计数器和 retriever 索引。
- `HarnessLifecycle` 新增 `dispose()` 方法释放健康检查引用。

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `Role` | `'system' \| 'user' \| 'assistant' \| 'tool'` |
| `Message` | 对话消息，含 role、content、toolCalls、meta |
| `MessageMeta` | 消息元数据：pinned、isFailureTrace、timestamp、tokens |
| `ToolCallRequest` | LLM 发起的工具调用请求（id + name + arguments） |
| `TokenUsage` | 单次 LLM 调用的 token 用量（input/output/cache） |
| `AgentAdapter` | LLM 适配器接口：chat() 必选，stream()/countTokens() 可选 |
| `LLMConfig` | 可选 LLM 配置：temperature、topP、maxTokens、stopSequences + 任意扩展字段 |
| `ChatParams` | chat() 入参：messages + tools + signal + config? (LLMConfig) |
| `ChatResponse` | chat() 返回：message + usage |
| `StreamChunk` | 流式响应片段：text_delta / tool_call_delta / done |
| `ToolSchema` | 工具的 JSON Schema 描述 |
| `JsonSchema` | JSON Schema 定义（支持的子集） |
| `AgentEvent` | 7 种事件的判别联合 |
| `DoneReason` | 循环终止原因：`'end_turn' \| 'max_iterations' \| 'token_budget' \| 'aborted' \| 'error'` |
| `ToolExecutionResult` | 工具批量执行的单条结果：toolCallId + result |
| `ExecutionStrategy` | 工具执行策略接口：execute(calls, handler, options) |
| `AgentLoopConfig` | AgentLoop 构造配置（含 parallel、executionStrategy、isSequentialTool） |

### 错误类

| 类 | code | 触发场景 |
|----|------|---------|
| `HarnessError` | 自定义（`HarnessErrorCode` 成员） | 所有编程错误的基类 |
| `MaxIterationsError` | `CORE_MAX_ITERATIONS` | 循环超过 maxIterations |
| `AbortedError` | `CORE_ABORTED` | 循环被外部中止 |
| `GuardrailBlockedError` | `GUARD_BLOCKED` | 护栏拦截执行 |
| `ToolValidationError` | `TOOL_VALIDATION` | 工具参数校验失败 |
| `TokenBudgetExceededError` | `CORE_TOKEN_BUDGET_EXCEEDED` | 累计 token 超出预算 |

**Wave-5C：`HarnessErrorCode` 已闭合**（不再 `(string & {})` widening）。成员改为模块前缀形式；适配器自定义代码走 `ADAPTER_CUSTOM` + `details.adapterCode` escape hatch。完整枚举见 `packages/core/src/core/errors.ts`；迁移映射见根 `CHANGELOG.md`。

### AgentLoop 类 + createAgentLoop 工厂

```ts
class AgentLoop {
  constructor(config: AgentLoopConfig)
  get usage(): TokenUsage
  get status(): 'idle' | 'running' | 'completed' | 'disposed'
  getMetrics(): { iteration: number; totalToolCalls: number; usage: TokenUsage }
  abort(): void
  dispose(): void
  async *run(messages: Message[]): AsyncGenerator<AgentEvent>
}

// 0.2.0 新增：与 harness-one 其余 `createX()` 风格对齐的工厂别名。
function createAgentLoop(config: AgentLoopConfig): AgentLoop;
```

两种形式等价。`new AgentLoop(...)` 给需要 subclass 访问的用户使用；`createAgentLoop(...)` 更便于用中间件包装（可以把返回值赋给一个对象字面量并插入装饰器）。

**行为**：在循环中调用 `adapter.chat()`（或 `adapter.stream()`），如果 LLM 返回 toolCalls，则依次调用 `onToolCall` 并将结果回填，继续循环直到 LLM 不再请求工具或触发安全阀（maxIterations / maxTotalTokens / abort）。

**非重入（0.2.0 新增）**：`run()` 在同一实例上并发调用会抛 `HarnessError(HarnessErrorCode.CORE_INVALID_STATE)`。两路并发时 `_iteration` / `cumulativeUsage` / `abortController` 会竞争，过去可能静默损坏状态；现在直接失败暴露误用。模式：**每条并发请求一个 AgentLoop 实例**，或把调用序列化。

**构造时输入验证**：`AgentLoopConfig` 中所有数值参数（`maxIterations`、`maxTotalTokens`、`maxStreamBytes`、`maxToolArgBytes`、`toolTimeoutMs`）在构造时校验，非正数或非有限值会立即抛出错误，防止无效配置静默生效。

**流式安全阀**：`AgentLoopConfig` 提供两个字节级限制防止超大流式响应：
- `maxStreamBytes` — 单次流式响应的最大字节数；超限时中断流并抛出 `AbortedError`
- `maxToolArgBytes` — 单个工具调用参数的最大字节数；超限时跳过该工具调用并返回 `toolError('validation')`

流字节计数器在流错误时**不重置**——累计字节数跨失败尝试保留，防止通过重复触发短流错误绕过 `maxStreamBytes` 预算。

**生命周期状态**（`status` getter）：
- `idle` — 构造后未运行
- `running` — `run()` 正在执行中
- `completed` — `run()` 正常结束（end_turn / max_iterations / token_budget）
- `disposed` — 调用 `dispose()` 后

**指标**（`getMetrics()`）：返回当前迭代次数、累计工具调用数和 token 用量的快照。

## 内部实现

### 循环机制

`AgentLoop.run()` 是一个 AsyncGenerator。Wave-5B 后 `run()` 自身仅负责编排（~65 行）：状态翻转、pre-iteration 预检、调用 `IterationRunner.runIteration(ctx)`、根据返回的 `IterationOutcome` 决定 `continue` 还是 yield `done` 终止。每轮迭代内部（`IterationRunner` 负责）按以下顺序：

1. （orchestrator 负责）检查 abort 信号（单一 AbortController.signal 作为唯一真实来源）
2. （orchestrator 负责）检查 maxIterations
3. （orchestrator 负责）检查累计 token 预算（inputTokens + outputTokens 之和，非负 clamp）
4. （runner）运行输入护栏（`inputPipeline`），若硬阻则通过 `bailOut` yield `guardrail_blocked` + `error` 并 abort
5. （runner）经 `AdapterCaller.call()` 调用 adapter（按 `streaming` 分支 `stream()` 或 `chat()`）；`AdapterCaller` 内部实现重试 + 指数退避，并在每次重试时回调 `onRetry` 以富化当前迭代 span
6. （runner）运行输出护栏（`outputPipeline`），若硬阻则 bailOut
7. （runner）若无 toolCalls → yield `message`，返回 `{ kind: 'terminated', reason: 'end_turn', totalUsage }`
8. （runner）若有 toolCalls → yield 所有 `tool_call` 事件，通过 `ExecutionStrategy` 执行（顺序或并行），运行 tool_output 护栏，yield 所有 `tool_result` 事件（保持原始调用顺序），将结果追加到 conversation，返回 `{ kind: 'continue' }`

`IterationRunner` 使用 `bailOut` 判别联合（`ErrorBail` / `GuardrailBail` / `BudgetBail` / `EndTurnBail`）统一所有终止分支的事件合流，取代过去 `run()` 中重复的 abort/span/done 三元组。

流式错误路径的错误类别（过去写到 `AgentLoop._lastStreamErrorCategory`）现由 `StreamHandler` 的 `StreamResult` 判别联合直接承载，`AdapterCaller` 将其包装进 `AdapterCallFail.errorCategory` 返回给 runner，不再有跨方法的实例侧信道。

### 并行工具执行

AgentLoop 支持通过 `ExecutionStrategy` 接口控制工具执行方式：

- `parallel: true` → 使用 `createParallelStrategy()`（语法糖）
- `executionStrategy` → 传入自定义策略（高级用法）
- `isSequentialTool` → 回调函数，判断工具是否需要顺序执行
- `maxParallelToolCalls` → 并发上限（默认 5）

并行模式下事件顺序确定：先 yield 所有 `tool_call`，再 yield 所有 `tool_result`（按原始调用顺序）。

### 工具执行策略

| 策略 | 工厂函数 | 行为 |
|------|---------|------|
| 顺序（默认） | `createSequentialStrategy()` | 逐个执行，与原有行为一致 |
| 并行 | `createParallelStrategy({ maxConcurrency? })` | Worker pool 并发执行，`sequential` 标记的工具在并行组之后顺序执行 |

### 事件总线错误隔离

event-bus.ts 的 `emit()` 方法对每个 handler 使用 try-catch 错误隔离，单个 handler 抛异常不影响其他 handler 的执行。

### FallbackAdapter 流式降级

FallbackAdapter 的 `stream()` 方法支持自动降级：当底层 adapter 未实现 stream() 时，自动回退到 chat() 并将完整响应拆分为流式 chunk，与 chat() 的回退模式一致。

### FallbackAdapter 并发安全

FallbackAdapter 使用互斥锁保护适配器切换逻辑。并发请求同时触发降级时，互斥锁确保只有一个请求执行适配器探测，其他请求等待结果，防止重复探测和竞态状态翻转。

### 对话裁剪与系统消息保留

AgentLoop 在超出 token 预算时裁剪历史对话。裁剪逻辑始终保留消息数组开头的所有连续系统消息（role 为 `'system'` 的消息），无论裁剪深度如何，确保指令和角色设定不丢失。

### Errors as Feedback

工具执行异常不会中断循环，而是将错误序列化为 `{ error: message }` 回填给 LLM，让模型自行修正。

### Generator 安全

`finally` 块检测外部 `.return()` / `.throw()` 关闭，确保 `done` 事件至少被标记。

### 迭代 span 富化（0.2.0）

当构造时传入 `traceManager`，AgentLoop 会在每次迭代开始时创建 `iteration-N` span，并附着以下**可查询属性**（此前只有 `inputTokens`/`outputTokens`）：

| 属性 | 值示例 | 用途 |
|---|---|---|
| `iteration` | `1` | 聚合同一迭代索引的 span（工具循环识别） |
| `adapter` | `"anthropic:claude-sonnet-4"` | 按 adapter 切片延迟 / 错误率 |
| `conversationLength` | `42` | 压缩压力信号 |
| `streaming` | `false` | 区分 chat() vs stream() 路径 |
| `toolCount` | `3` | 一次迭代返回的工具调用数（工具爆炸预警） |
| `inputTokens` / `outputTokens` | `1234` / `567` | 与 cost tracker 对齐 |

**adapter 重试（0.2.0）**：重试不再隐身——每次可重试错误触发 `adapter_retry` span event，属性含 `attempt`、`errorCategory`、`path`（`'chat'` 或 `'stream'`），错误消息预览前 500 字符。当重试耗尽进入 error 路径时，`errorCategory` / `error` 也写到 span 属性上再调用 `endSpan(..., 'error')`。

**工具 span 错误归因**：每个工具调用的子 span 在创建时即设 `toolName` 和 `toolCallId` 属性（不只在 span.name 字符串里），失败时再补 `errorMessage` / `errorName` 后以 `'error'` 状态关闭。trace 后端可按 `toolName` 直接聚合失败率。

## 依赖关系

- **依赖**: `_internal/`（间接，通过其他模块）
- **被依赖**: 所有功能模块通过类型导入依赖 core

## 扩展点

- 实现 `AgentAdapter` 接口适配任意 LLM 提供商
- 通过 `ChatParams.config` 传入 `LLMConfig`，由 adapter 转发给底层 LLM（temperature、topP、maxTokens 等）。`LLMConfig` 支持 `extra?: Readonly<Record<string, unknown>>` 字段，允许 adapter 自定义额外参数
- 所有数值容量限制（`maxIterations`、`maxTotalTokens` 等）均可在 `AgentLoopConfig` 中配置；非正数值在构造时被拒绝
- 通过 `onToolCall` 回调自定义工具调度逻辑
- 通过 `signal` (AbortSignal) 实现外部取消控制
- 通过 `executionStrategy` 传入自定义工具执行策略（如依赖感知、优先级调度）
- 通过 `parallel: true` 启用内置并行执行策略

## 设计决策

1. **AgentLoop 是唯一的 class**——需要维护迭代状态（cumulativeUsage、AbortController），工厂函数不适合
2. **AsyncGenerator 而非回调**——调用方通过 `for await` 消费事件，天然支持背压
3. **token 非负 clamp**——`Math.max(0, ...)` 防止恶意 adapter 通过负数绕过预算检查
4. **HarnessError 层级**——每个子类携带 `.code`（程序判断）+ `.suggestion`（人类可读修复建议）

## Wave-8 Production Hardening

1. **JSON Schema 递归深度限制**：`validate()` 现在强制 `MAX_VALIDATION_DEPTH=64` 的递归深度上限，防止病态 schema（如深度嵌套的 `$ref` 或递归定义）导致的栈溢出。

## 已知限制

- 累计 token 检查在调用 LLM **之前**进行，不含当次调用的 token
