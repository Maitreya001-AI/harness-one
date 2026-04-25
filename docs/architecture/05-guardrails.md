# Guardrails

> 安全护栏：Pipeline 编排、Guardrail Retry、5 个内置护栏，AgentLoop 强制 hook。

## AgentLoop 强制 hook 点

`AgentLoopConfig.inputPipeline?: GuardrailPipeline` 和 `outputPipeline?: GuardrailPipeline`。
每轮迭代固定顺序：

1. **Input** — 调 adapter 前，对最新 user turn 跑 `runInput`
2. **Tool output** — 工具执行后，对结果跑 `runToolOutput`；block 时将 result 替换为
   `JSON.stringify({ error: 'GUARDRAIL_VIOLATION: <guardName>', reason })` 回写，继续下一轮（LLM 看到
   结构化错误，不会孤儿 tool_use）
3. **Output** — assistant final answer 后，跑 `runOutput`

**Hard-block 语义**：
- `this.abortController.abort('guardrail_violation')` — 关闭上游 stream 连接
- yield `{ type: 'guardrail_blocked', phase, guardName, details }` 事件
- yield `{ type: 'error', error: HarnessError('GUARDRAIL_VIOLATION') }`
- return 终止 loop
- `error-classifier` 明确把 `GUARDRAIL_VIOLATION` 归类为 `retryable: false`（不进入 retry 路径）

**无 pipeline 配置** → AgentLoop 实例首次 `run()` 时 `safeWarn` 一次（推荐 `createSecurePreset`）。
后续不再 warn。

**Wrapper 接管的语义化 opt-in**：当外层 harness（如 `createSecurePreset`）在
`harness.run()` 边界跑 guardrail pipeline、而非把 pipeline 穿进 `AgentLoop` 时，
传入 `AgentLoopConfig.guardrailsManagedExternally: true` 抑制此警告。preset 内部
已自动声明。直接调 `createAgentLoop` 的用户不应设置该字段——它**仅是契约声明，不是
开关**：声明 `true` 但未在外层运行 guardrail，等于在静默关闭一条 fail-closed 安全信号
而无任何替代防护。两层重复挂载 pipeline 会双跑（rate-limit 双计数）且 tool-result block
语义冲突（preset 终止 vs AgentLoop 改写 stub 续跑），故由 wrapper 单点持有。

## 概述

guardrails 模块实现 AI 安全层：通过 Pipeline 将多个护栏串联执行（输入/输出/工具输出/RAG 上下文四个钩子点），支持 fail-closed 默认行为；通过 `withGuardrailRetry` 在护栏拦截后自动重试并重新生成；内置 5 个护栏——注入检测、内容过滤、速率限制、Schema 验证、PII 检测。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/guardrails/types.ts` | 类型定义：`GuardrailVerdict`、`Guardrail`、`PipelineResult`、`PermissionLevel` 等 | 19 |
| `src/guardrails/pipeline.ts` | `createPipeline` + `runInput`/`runOutput`/`runToolOutput`/`runRagContext`——串行执行护栏 | 417 |
| `src/guardrails/self-healing.ts` | `withGuardrailRetry`——护栏失败后自动重试 | 194 |
| `src/guardrails/rate-limiter.ts` | `createRateLimiter`——滑动窗口速率限制 | 199 |
| `src/guardrails/injection-detector.ts` | `createInjectionDetector`——prompt 注入检测 | 234 |
| `src/guardrails/schema-validator.ts` | `createSchemaValidator`——JSON Schema 验证 | 127 |
| `src/guardrails/content-filter.ts` | `createContentFilter`——关键词/正则过滤（导出 `isReDoSCandidate` 供 pii-detector 复用） | 157 |
| `src/guardrails/pii-detector.ts` | `createPIIDetector`——邮箱/电话/SSN/信用卡/IPv4/API key/PEM 私钥检测（Luhn 校验） | 163 |
| `src/guardrails/index.ts` | 公共导出桶文件 | 29 |

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
  totalTimeoutMs?: number; // 所有护栏的总挂钟超时，默认 30s
}): GuardrailPipeline
```

**runInput(pipeline, ctx)** / **runOutput(pipeline, ctx)**
```ts
function runInput(pipeline: GuardrailPipeline, ctx: GuardrailContext): Promise<PipelineResult>
function runOutput(pipeline: GuardrailPipeline, ctx: GuardrailContext): Promise<PipelineResult>
```

**withGuardrailRetry(config, initialContent)**
```ts
function withGuardrailRetry(config: {
  maxRetries?: number;  // 默认 3
  guardrails: Array<{ name: string; guard: Guardrail }>;
  buildRetryPrompt: (content: string, failures: Array<{ reason: string }>) => string;
  regenerate: (prompt: string) => Promise<string>;
  regenerateTimeoutMs?: number;
  estimateTokens?: (text: string) => number;
  maxTotalTokens?: number;
}, initialContent: string): Promise<{ content: string; attempts: number; passed: boolean; failureReason?: string; totalTokens?: number }>
```

**内置护栏工厂**

```ts
function createRateLimiter(config: {
  max: number; windowMs: number; keyFn?: (ctx) => string; maxKeys?: number;
  distributed?: boolean;  // throws CORE_INVALID_CONFIG (use @harness-one/redis)
  bucketMs?: number;      // PERF-012: time-bucketed counting for high-volume keys
  onEviction?: (evicted: { key: string; lastSeen: number }) => void;  // SEC-013: LRU flood detection
}): { name: string; guard: Guardrail }

function createInjectionDetector(config?: {
  extraPatterns?: RegExp[]; sensitivity?: 'low' | 'medium' | 'high';
}): { name: string; guard: Guardrail }

function createSchemaValidator(schema: JsonSchema): { name: string; guard: Guardrail }

function createContentFilter(config: {
  blocked?: string[]; blockedPatterns?: RegExp[];
}): { name: string; guard: Guardrail }

function createPIIDetector(config?: {
  email?: boolean;       // 默认 true
  phone?: boolean;       // 默认 true
  ssn?: boolean;         // 默认 true
  creditCard?: boolean;  // 默认 true（Luhn 校验）
  ipAddress?: boolean;   // 默认 false（opt-in，避免误报）
  apiKey?: boolean;      // 默认 false（OpenAI/AWS/GitHub/Stripe/Google 格式）
  privateKey?: boolean;  // 默认 false（PEM 头检测）
  customPatterns?: Array<{ name: string; pattern: RegExp }>;
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
4. 阿拉伯语同形字映射（ا→a、ھ→h、ە→e）
5. 空白归一化
6. 移除 Markdown 格式字符
7. 按灵敏度级别匹配模式：low（9 个精确模式）→ medium（+4 个模糊模式 + base64 检测 + 数学字母数字 Unicode 块检测）→ high（+5 个激进模式）

内容长度超过 100KB 时，注入检测采样前缀 + 中段 + 后缀三段进行扫描，避免对超大输入进行全量正则匹配，同时关闭中段载荷绕过漏洞。

### 速率限制

滑动窗口算法 + LRU key 淘汰（maxKeys 默认 10000）。每次请求清除过期时间戳，检查窗口内计数。

**分布式模式降级**：当速率限制器配置了分布式后端但后端不可用时，不再抛出运行时异常——改为返回一个 no-op guardrail（始终 `allow`），确保分布式后端故障不会中断 Agent 执行。

### 内容过滤 ReDoS 防护

`createContentFilter` 在注册用户提供的 `blockedPatterns` 时，对每个正则表达式执行安全性预检：用短测试字符串测量匹配耗时，超过阈值的正则被拒绝并抛出错误，防止恶意或病态正则导致的灾难性回溯（ReDoS）。

### Guardrail Retry 与 token 估算

withGuardrailRetry 执行逻辑：对每次尝试，逐个运行 guardrails，收集 block/modify 失败原因。全部通过则返回成功；否则用 `buildRetryPrompt` 构建重试提示，调用 `regenerate` 获取新内容，重复直到 maxRetries。

`estimateTokens` 回调用于累计各轮内容的 token 用量，与 `maxTotalTokens` 配合实现自愈过程的总 token 预算控制。内置默认估算器已优化为单次遍历（`Math.ceil(text.length / 4)`），避免不必要的中间字符串分配。

### PII 检测

`createPIIDetector` 内置 7 种常见 PII 模式：

- 默认 on：email（拒绝连续点号）、phone（要求至少一个分隔符）、SSN（支持有无连字符）、creditCard（带 Luhn 校验）
- 默认 off（opt-in）：ipAddress（带 0–255 八位组校验）、apiKey（OpenAI `sk-*` / AWS `AKIA*` / GitHub `ghp_` 等 + 上下文限定）、privateKey（PEM 头）

信用卡正则匹配后再跑 Luhn 校验确认有效性，大幅降低 16 位连号误报。API
key 检测要求键值前有 `=` / `:` / `"` / 空白等语法锚点，避免讨论文本里
的随机字符串被误判。`customPatterns` 接受用户扩展列表，每个正则在注册
时跑与 `createContentFilter` 相同的 ReDoS 预检（通过 `isReDoSCandidate`
共享实现）。

## 依赖关系

- **依赖**: `core/types.ts`（JsonSchema）、`infra/json-schema.ts`（Schema 验证器）
- **被依赖**: 无直接模块依赖

## 扩展点

- 实现 `Guardrail` 函数签名自定义任意护栏
- `createInjectionDetector` 的 `extraPatterns` 参数添加自定义检测模式
- `createRateLimiter` 的 `keyFn` 支持按用户/IP 等维度限流
- `withGuardrailRetry` 的 `regenerate` 回调接入 LLM 重新生成

## 设计决策

1. **Fail-Closed 默认**——安全优先：护栏出错时拦截请求而非放行。Fail-open 模式下，错误产生的 allow verdict 附带 `reason` 字段以区分真正的 allow
2. **Verdict 三态**——allow（可选 reason）/block/modify 覆盖所有场景，modify 允许护栏自行修改内容
3. **Unicode-aware 词边界**——内容过滤器使用 `\p{L}\p{N}` Unicode 属性替代 ASCII `\w`，正确处理非 ASCII 关键词（如"café"）的词边界检测
3. **Pipeline 与护栏分离**——护栏是纯函数，Pipeline 负责编排，关注点分离
4. **branded GuardrailPipeline**——防止用户直接构造内部结构

## 生产强化

1. **中段载荷注入采样**：注入检测器对超大内容（>100k 字符）采样前缀 + 中段 + 后缀三段进行扫描，而非仅前缀+后缀，防止攻击者将注入载荷嵌入大内容中段绕过检测。
2. **阿拉伯语同形字覆盖**：注入标准化流程含阿拉伯语同形字映射（ا→a、ھ→h、ە→e），补充西里尔字母同形字防御。
3. **Pipeline 总超时**：`createPipeline()` 支持 `totalTimeoutMs` 配置项（默认 30s），对所有护栏的总挂钟时间设置上限，防止单个或多个护栏组合导致的无界管线延迟。

## 已知限制

- 注入检测基于正则模式匹配，无语义理解能力
- Pipeline 不支持并行执行护栏
- 速率限制器的时间戳数组在高并发下可能增长较快
