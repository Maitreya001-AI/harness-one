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
| `src/core/agent-loop.ts` | AgentLoop 类——核心执行循环（支持并行工具执行、流式响应） | ~440 |
| `src/core/execution-strategies.ts` | 工具执行策略：顺序 + 并行（worker pool 并发控制） | ~100 |
| `src/core/index.ts` | 公共导出桶文件 | ~38 |

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
| `DoneReason` | 循环终止原因：`'end_turn' \| 'max_iterations' \| 'token_budget' \| 'aborted'` |
| `ToolExecutionResult` | 工具批量执行的单条结果：toolCallId + result |
| `ExecutionStrategy` | 工具执行策略接口：execute(calls, handler, options) |
| `AgentLoopConfig` | AgentLoop 构造配置（含 parallel、executionStrategy、isSequentialTool） |

### 错误类

| 类 | code | 触发场景 |
|----|------|---------|
| `HarnessError` | 自定义 | 所有编程错误的基类 |
| `MaxIterationsError` | `MAX_ITERATIONS` | 循环超过 maxIterations |
| `AbortedError` | `ABORTED` | 循环被外部中止 |
| `GuardrailBlockedError` | `GUARDRAIL_BLOCKED` | 护栏拦截执行 |
| `ToolValidationError` | `TOOL_VALIDATION` | 工具参数校验失败 |
| `TokenBudgetExceededError` | `TOKEN_BUDGET_EXCEEDED` | 累计 token 超出预算 |

### AgentLoop 类

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
```

**行为**：在循环中调用 `adapter.chat()`（或 `adapter.stream()`），如果 LLM 返回 toolCalls，则依次调用 `onToolCall` 并将结果回填，继续循环直到 LLM 不再请求工具或触发安全阀（maxIterations / maxTotalTokens / abort）。

**流式安全阀**：`AgentLoopConfig` 提供两个字节级限制防止超大流式响应：
- `maxStreamBytes` — 单次流式响应的最大字节数；超限时中断流并抛出 `AbortedError`
- `maxToolArgBytes` — 单个工具调用参数的最大字节数；超限时跳过该工具调用并返回 `toolError('validation')`

**生命周期状态**（`status` getter）：
- `idle` — 构造后未运行
- `running` — `run()` 正在执行中
- `completed` — `run()` 正常结束（end_turn / max_iterations / token_budget）
- `disposed` — 调用 `dispose()` 后

**指标**（`getMetrics()`）：返回当前迭代次数、累计工具调用数和 token 用量的快照。

## 内部实现

### 循环机制

AgentLoop.run() 是一个 AsyncGenerator，每次迭代：
1. 检查 abort 信号（单一 AbortController.signal 作为唯一真实来源）
2. 检查 maxIterations
3. 检查累计 token 预算（inputTokens + outputTokens 之和，非负 clamp）
4. 调用 adapter.chat()
5. 若无 toolCalls → yield `message` + `done(end_turn)` 并返回
6. 若有 toolCalls → yield 所有 `tool_call` 事件，通过 ExecutionStrategy 执行（顺序或并行），yield 所有 `tool_result` 事件（保持原始调用顺序），将结果追加到 conversation，继续循环

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

## 依赖关系

- **依赖**: `_internal/`（间接，通过其他模块）
- **被依赖**: 所有功能模块通过类型导入依赖 core

## 扩展点

- 实现 `AgentAdapter` 接口适配任意 LLM 提供商
- 通过 `ChatParams.config` 传入 `LLMConfig`，由 adapter 转发给底层 LLM（temperature、topP、maxTokens 等）。`LLMConfig` 支持 `[key: string]: unknown` 索引签名，允许 adapter 自定义额外参数
- 通过 `onToolCall` 回调自定义工具调度逻辑
- 通过 `signal` (AbortSignal) 实现外部取消控制
- 通过 `executionStrategy` 传入自定义工具执行策略（如依赖感知、优先级调度）
- 通过 `parallel: true` 启用内置并行执行策略

## 设计决策

1. **AgentLoop 是唯一的 class**——需要维护迭代状态（cumulativeUsage、AbortController），工厂函数不适合
2. **AsyncGenerator 而非回调**——调用方通过 `for await` 消费事件，天然支持背压
3. **token 非负 clamp**——`Math.max(0, ...)` 防止恶意 adapter 通过负数绕过预算检查
4. **HarnessError 层级**——每个子类携带 `.code`（程序判断）+ `.suggestion`（人类可读修复建议）

## 已知限制

- 累计 token 检查在调用 LLM **之前**进行，不含当次调用的 token
