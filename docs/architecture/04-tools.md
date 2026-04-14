# Tools

> 工具系统：定义、注册、JSON Schema 验证、速率限制、执行、capability 分类。

## Wave-5A: Production defaults (1.0-rc)

**默认配额（T08）**：`createRegistry()` 无参数时默认 `maxCallsPerTurn=20`, `maxCallsPerSession=100`,
`timeoutMs=30000`。显式传 `Infinity` 或数字可覆盖；`getConfig(): ResolvedRegistryConfig` 供观测。

**Tool capability 分类（T09）**：

```ts
type ToolCapabilityValue = 'readonly' | 'filesystem' | 'network' | 'shell' | 'destructive';
```

`defineTool({ capabilities: ['network'] })` 声明工具能力；`createRegistry({ allowedCapabilities })`
默认 `['readonly']`（fail-closed）。注册时 capability 不在 allow-list → 抛 `TOOL_CAPABILITY_DENIED`。
未声明 capability 的工具本阶段只 `safeWarn`（**Wave-5C 将升级为 throw**）。

**逃生门**：`createPermissiveRegistry()` 允许全部 5 个 capability。

**Trust model**: `capabilities` 是**声明性契约**，不是沙箱。Host 侧仍需独立验证（如 middleware 拦截
network/shell syscall），不可仅依赖工具自报。

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
| `ToolDefinition<TParams>` | 工具定义：name、description、parameters (JsonSchema)、execute、sequential?、middleware? |
| `ToolMiddleware<TParams>` | `(ctx, next) => Promise<ToolResult>` — 横切关注点的洋葱包装器（0.2.0 新增） |
| `ToolCall` | 解析后的工具调用：id、name、arguments (Record) |
| `ValidationError` | 验证错误：path、message、suggestion |
| `SchemaValidator` | 自定义校验器接口：validate(schema, params) → `{ valid, errors } \| Promise<{ valid, errors }>` |

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

传入 `validator` 后，`execute()` 流程中的参数校验将委托给该实现，替代内置的 `validateToolCall()`。`execute()` 会 `await` 校验器的返回值，支持同步和异步两种实现。典型用例：注入 Ajv 以获得完整 JSON Schema Draft-07 支持（见 `examples/tools/ajv-validator.ts`）。

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

### ToolMiddleware（0.2.0）

`ToolDefinition.middleware?: readonly ToolMiddleware[]` 支持围绕 `execute` 组合横切关注点——重试、auth、circuit-breaker、埋点——而无需改写每个 tool 的实现。语义为 Koa/Express 风格的"洋葱"：

```ts
export type ToolMiddleware<TParams = unknown> = (
  ctx: { readonly toolName: string; readonly params: TParams; readonly signal?: AbortSignal },
  next: () => Promise<ToolResult>,
) => Promise<ToolResult>;
```

**调用顺序**：middleware 数组 `[outer, middle, inner]` 时，`outer` 最先收到 ctx，其 `next()` 进入 `middle.pre`、再进入 `inner.pre`、再进入真正的 `execute`，然后依次回到 `inner.post` / `middle.post` / `outer.post`。

**短路**：middleware 可以不调用 `next()` 直接返回一个 `ToolResult`，此时后续 middleware 和 execute 都不会执行。适合做权限预检或 circuit breaker。

**结果转换**：middleware 可以在 `next()` 返回后重写 result。

**关于 timeout**：timeout（`toolTimeoutMs`）由 registry 以 `Promise.race` 实现，作用于整条 middleware 链（外层包含）——单个 middleware 不能覆盖/绕过 timeout。

**示例：重试 + 埋点**：

```ts
const withRetry: ToolMiddleware = async (ctx, next) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await next();
    if (r.success || !r.error.retryable) return r;
  }
  return next();
};

const withTiming: ToolMiddleware = async (ctx, next) => {
  const start = Date.now();
  const r = await next();
  metrics.record(`tool.${ctx.toolName}.latency`, Date.now() - start);
  return r;
};

defineTool<{ q: string }>({
  name: 'search',
  description: '...',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  middleware: [withTiming, withRetry],  // 外层 → 内层
  execute: async ({ q }) => toolSuccess(await search(q)),
});
```

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
