# Guardrails

> 安全护栏：Pipeline 编排、自愈重试、4 个内置护栏。

## 概述

guardrails 模块实现 AI 安全层：通过 Pipeline 将多个护栏串联执行（输入/输出双向），支持 fail-closed 默认行为；通过 `withSelfHealing` 在护栏拦截后自动重试并重新生成；内置 4 个护栏——注入检测、内容过滤、速率限制、Schema 验证。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/guardrails/types.ts` | 类型定义：GuardrailVerdict、Guardrail、PipelineResult 等 | ~36 |
| `src/guardrails/pipeline.ts` | createPipeline + runInput/runOutput——串行执行护栏 | ~131 |
| `src/guardrails/self-healing.ts` | withSelfHealing——护栏失败后自动重试 | ~62 |
| `src/guardrails/rate-limiter.ts` | createRateLimiter——滑动窗口速率限制 | ~67 |
| `src/guardrails/injection-detector.ts` | createInjectionDetector——prompt 注入检测 | ~111 |
| `src/guardrails/schema-validator.ts` | createSchemaValidator——JSON Schema 验证 | ~39 |
| `src/guardrails/content-filter.ts` | createContentFilter——关键词/正则过滤 | ~44 |
| `src/guardrails/index.ts` | 公共导出桶文件 | ~28 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `GuardrailVerdict` | `{ action: 'allow' } \| { action: 'block'; reason } \| { action: 'modify'; modified; reason }` |
| `GuardrailContext` | 护栏输入：content + meta |
| `Guardrail` | 护栏函数签名：`(ctx) => Promise<GuardrailVerdict> \| GuardrailVerdict` |
| `GuardrailEvent` | 护栏执行事件：guardrail、direction、verdict、latencyMs |
| `PipelineResult` | Pipeline 执行结果：passed、verdict、results、modifiedContent? |
| `GuardrailPipeline` | Pipeline 不透明类型（branded） |

### 工厂函数

**createPipeline(config)**
```ts
function createPipeline(config: {
  input?: Array<{ name: string; guard: Guardrail }>;
  output?: Array<{ name: string; guard: Guardrail }>;
  failClosed?: boolean;  // 默认 true
  onEvent?: (event: GuardrailEvent) => void;
  maxResults?: number;   // 限制 PipelineResult.results 数组长度，默认不限制
}): GuardrailPipeline
```

**runInput(pipeline, ctx)** / **runOutput(pipeline, ctx)**
```ts
function runInput(pipeline: GuardrailPipeline, ctx: GuardrailContext): Promise<PipelineResult>
function runOutput(pipeline: GuardrailPipeline, ctx: GuardrailContext): Promise<PipelineResult>
```

**withSelfHealing(config, initialContent)**
```ts
function withSelfHealing(config: {
  maxRetries?: number;  // 默认 3
  guardrails: Array<{ name: string; guard: Guardrail }>;
  buildRetryPrompt: (content: string, failures: Array<{ reason: string }>) => string;
  regenerate: (prompt: string) => Promise<string>;
  regenerateTimeoutMs?: number;
  estimateTokens?: (text: string) => number;
  maxTotalTokens?: number;
}, initialContent: string): Promise<{ content: string; attempts: number; passed: boolean; totalTokens?: number }>
```

**内置护栏工厂**

```ts
function createRateLimiter(config: {
  max: number; windowMs: number; keyFn?: (ctx) => string; maxKeys?: number;
}): { name: string; guard: Guardrail }

function createInjectionDetector(config?: {
  extraPatterns?: RegExp[]; sensitivity?: 'low' | 'medium' | 'high';
}): { name: string; guard: Guardrail }

function createSchemaValidator(schema: JsonSchema): { name: string; guard: Guardrail }

function createContentFilter(config: {
  blocked?: string[]; blockedPatterns?: RegExp[];
}): { name: string; guard: Guardrail }
```

## 内部实现

### Pipeline 短路逻辑

护栏按数组顺序串行执行。遇到 `block` 立即返回（短路）。遇到 `modify` 时，将修改后的内容传递给后续护栏继续执行（通过更新 context）。所有护栏执行完毕后，如果有任何 `modify` 发生，最终的 PipelineResult 包含 `modifiedContent?: string` 字段。Pipeline 仅在 `block` 时短路。

### Fail-Closed 安全默认

`failClosed: true`（默认）时，护栏函数抛异常等同于 `block`。`failClosed: false` 时异常等同于 `allow`（跳过该护栏）。

### 注入检测多层防御

createInjectionDetector 的标准化流程：
1. 移除零宽字符（U+200B 等）
2. NFKC Unicode 归一化
3. 西里尔字母同形字映射（a/e/o/c/p/y/x/i）
4. 空白归一化
5. 移除 Markdown 格式字符
6. 按灵敏度级别匹配模式：low（9 个精确模式）→ medium（+4 个模糊模式 + base64 检测 + 数学字母数字 Unicode 块检测）→ high（+5 个激进模式）

内容长度超过 100KB 时，注入检测切换为滑动窗口模式：将内容分割为若干重叠窗口逐段扫描，避免对超大输入进行全量正则匹配，防止 ReDoS 风险。

### 速率限制

滑动窗口算法 + LRU key 淘汰（maxKeys 默认 10000）。每次请求清除过期时间戳，检查窗口内计数。

**分布式模式降级**：当速率限制器配置了分布式后端但后端不可用时，不再抛出运行时异常——改为返回一个 no-op guardrail（始终 `allow`），确保分布式后端故障不会中断 Agent 执行。

### 内容过滤 ReDoS 防护

`createContentFilter` 在注册用户提供的 `blockedPatterns` 时，对每个正则表达式执行安全性预检：用短测试字符串测量匹配耗时，超过阈值的正则被拒绝并抛出错误，防止恶意或病态正则导致的灾难性回溯（ReDoS）。

### 自愈循环与 token 估算

withSelfHealing 执行逻辑：对每次尝试，逐个运行 guardrails，收集 block/modify 失败原因。全部通过则返回成功；否则用 `buildRetryPrompt` 构建重试提示，调用 `regenerate` 获取新内容，重复直到 maxRetries。

`estimateTokens` 回调用于累计各轮内容的 token 用量，与 `maxTotalTokens` 配合实现自愈过程的总 token 预算控制。内置默认估算器已优化为单次遍历（`Math.ceil(text.length / 4)`），避免不必要的中间字符串分配。

## 依赖关系

- **依赖**: `core/types.ts`（JsonSchema）、`_internal/json-schema.ts`（Schema 验证器）
- **被依赖**: 无直接模块依赖

## 扩展点

- 实现 `Guardrail` 函数签名自定义任意护栏
- `createInjectionDetector` 的 `extraPatterns` 参数添加自定义检测模式
- `createRateLimiter` 的 `keyFn` 支持按用户/IP 等维度限流
- `withSelfHealing` 的 `regenerate` 回调接入 LLM 重新生成

## 设计决策

1. **Fail-Closed 默认**——安全优先：护栏出错时拦截请求而非放行
2. **Verdict 三态**——allow/block/modify 覆盖所有场景，modify 允许护栏自行修改内容
3. **Pipeline 与护栏分离**——护栏是纯函数，Pipeline 负责编排，关注点分离
4. **branded GuardrailPipeline**——防止用户直接构造内部结构

## 已知限制

- 注入检测基于正则模式匹配，无语义理解能力
- Pipeline 不支持并行执行护栏
- 速率限制器的时间戳数组在高并发下可能增长较快
