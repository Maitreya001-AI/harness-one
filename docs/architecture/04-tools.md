# Tools

> 工具系统：定义、注册、JSON Schema 验证、速率限制、执行。

## 概述

tools 模块提供完整的工具生命周期管理：通过 `defineTool()` 创建带自动错误捕获的工具定义，通过 `createRegistry()` 注册、查找、验证和执行工具，通过 `validateToolCall()` 对参数进行 JSON Schema 校验。工具执行结果为 `ToolResult` 联合类型——成功返回数据，失败返回结构化反馈（Errors as Data）。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/tools/types.ts` | 类型定义 + toolSuccess/toolError 辅助函数 | ~61 |
| `src/tools/define-tool.ts` | defineTool 工厂——创建冻结工具定义 | ~45 |
| `src/tools/registry.ts` | createRegistry 工厂——注册、验证、执行、速率限制 | ~152 |
| `src/tools/validate.ts` | validateToolCall——委托 _internal JSON Schema 验证器 | ~36 |
| `src/tools/index.ts` | 公共导出桶文件 | ~24 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `ToolFeedback` | 失败反馈：message、category、suggestedAction、retryable |
| `ToolResult<T>` | `{ success: true; data: T } \| { success: false; error: ToolFeedback }` |
| `ToolDefinition<TParams>` | 工具定义：name、description、parameters (JsonSchema)、execute、sequential? |
| `ToolCall` | 解析后的工具调用：id、name、arguments (Record) |
| `ValidationError` | 验证错误：path、message、suggestion |
| `SchemaValidator` | 自定义校验器接口：validate(schema, params) → { valid, errors } |

### 辅助函数

```ts
function toolSuccess<T>(data: T): ToolResult<T>
function toolError(message: string, category: ToolFeedback['category'],
  suggestedAction: string, retryable?: boolean): ToolResult<never>
```

### 工厂函数

**defineTool(def)**
```ts
function defineTool<TParams>(def: {
  name: string; description: string; parameters: JsonSchema;
  execute: (params: TParams, signal?: AbortSignal) => Promise<ToolResult>;
}): ToolDefinition<TParams>
```
返回 `Object.freeze()` 冻结的工具定义。execute 内部异常自动捕获为 `toolError('internal')`。

**createRegistry(config?)**
```ts
function createRegistry(config?: {
  maxCallsPerTurn?: number;   // 默认 Infinity
  maxCallsPerSession?: number; // 默认 Infinity
  validator?: SchemaValidator; // 自定义校验器（默认使用内置 JSON Schema 验证器）
}): ToolRegistry
```
ToolRegistry 接口：`register()`, `get()`, `list(namespace?)`, `schemas()`, `execute()`, `handler()`, `resetTurn()`, `resetSession()`.

传入 `validator` 后，`execute()` 流程中的参数校验将委托给该实现，替代内置的 `validateToolCall()`。典型用例：注入 Ajv 以获得完整 JSON Schema Draft-07 支持（见 `examples/tools/ajv-validator.ts`）。

**validateToolCall(schema, params)**
```ts
function validateToolCall(schema: JsonSchema, params: unknown):
  { valid: boolean; errors: ValidationError[] }
```

## 内部实现

### 执行流水线

`registry.execute(call)` 的完整流程：
1. 检查 turnCalls / sessionCalls 限制
2. **Pre-claim 计数器**（turnCalls++, sessionCalls++）——在任何异步操作之前预占槽位，防止 TOCTOU 竞态
3. 查找工具（未找到：释放计数器，返回 `toolError('not_found')`）
4. JSON.parse arguments（失败：释放计数器，返回 `toolError('validation')`）
5. validateToolCall 校验参数（失败：释放计数器，返回验证错误）
6. 权限检查（失败：释放计数器，返回 `toolError('permission')`）
7. 创建 AbortController 用于超时控制，将 signal 传给 `tool.execute(params, signal)` 并在 finally 块中清理 timer
8. 注意：执行失败（execute 抛出异常）**不释放**计数器——已调用的工具已消耗槽位

### handler() 桥接

`registry.handler()` 返回一个 `(call: ToolCallRequest) => Promise<unknown>` 函数，可直接传给 `AgentLoop.onToolCall`。成功时返回 `data`，失败时返回完整 `ToolResult` 对象——让 LLM 看到结构化错误反馈。

### 工具名校验

注册时校验名称匹配 `/^[a-zA-Z][a-zA-Z0-9_.]*$/`，支持命名空间（如 `fs.readFile`）。`list(namespace)` 按前缀过滤。

## 依赖关系

- **依赖**: `core/types.ts`（JsonSchema、ToolCallRequest、ToolSchema）、`core/errors.ts`（HarnessError）、`_internal/json-schema.ts`
- **被依赖**: 无直接模块依赖

## 扩展点

- 实现 `SchemaValidator` 接口注入外部校验器（如 Ajv），通过 `createRegistry({ validator })` 传入
- 实现 `ToolDefinition.execute` 自定义工具逻辑
- 通过 `toolSuccess` / `toolError` 统一返回格式
- namespace 前缀支持工具分组（如 `db.query`, `db.insert`）

## 设计决策

1. **Errors as Data**——工具失败不抛异常，返回 `ToolResult.success === false`，让 LLM 接收反馈并自行修正
2. **defineTool 自动 try/catch**——防止工具实现的未捕获异常泄露到 AgentLoop
3. **Object.freeze**——工具定义注册后不可变
4. **速率限制内置**——per-turn 和 per-session 两级限制，防止工具滥用。采用 Pre-claim 模式确保并发安全（TOCTOU-safe）
5. **AbortSignal 超时**——timeout 使用 AbortController 而非裸 setTimeout，允许工具实现响应取消信号
6. **sequential 标志**——`ToolDefinition.sequential?: boolean` 允许工具声明自己需要顺序执行（即使在并行模式下）

## 已知限制

- 不支持工具定义的热更新（注册后不可修改或删除）
