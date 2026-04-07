# Context

> 上下文工程：Token 预算、打包、压缩、缓存稳定性分析。

## 概述

context 模块处理 LLM 上下文窗口的工程问题：通过 TokenBudget 分段管理 token 预算，通过 packContext 以 HEAD/MID/TAIL 布局打包消息（MID 段超限时从前端裁剪），通过 compress 提供 4 种内置压缩策略，通过 analyzeCacheStability 评估两次调用间的缓存命中率。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/context/types.ts` | 类型定义：Segment、TokenBudget、ContextLayout、CompressionStrategy 等 | ~84 |
| `src/context/count-tokens.ts` | countTokens + registerTokenizer——委托 _internal 估算器 | ~44 |
| `src/context/budget.ts` | createBudget 工厂——分段 token 预算管理 | ~98 |
| `src/context/pack.ts` | packContext——HEAD/MID/TAIL 打包 | ~57 |
| `src/context/compress.ts` | compress + 4 种内置策略 | ~252 |
| `src/context/cache-stability.ts` | analyzeCacheStability——缓存稳定性分析 | ~102 |
| `src/context/index.ts` | 公共导出桶文件 | ~28 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `Segment` | 预算分段：name、maxTokens、trimPriority、reserved |
| `BudgetConfig` | 预算配置：totalTokens、segments、responseReserve |
| `TokenBudget` | 预算追踪接口 |
| `ContextLayout` | 打包布局：head + mid + tail + budget |
| `CompressionStrategy` | 压缩策略接口：name + compress() |
| `CacheStabilityReport` | 缓存分析报告 |
| `CompressOptions` | compress() 选项 |

### 工厂函数

**createBudget(config)**
```ts
function createBudget(config: BudgetConfig): TokenBudget
```
TokenBudget 接口：`remaining(segment)`, `allocate(segment, tokens)`, `reset(segment)`, `needsTrimming()`, `trimOrder()`.

**countTokens(model, messages)** / **registerTokenizer(model, tokenizer)**
```ts
function countTokens(model: string, messages: readonly Message[]): number
function registerTokenizer(model: string, tokenizer: Tokenizer): void
```

**packContext(layout, model?)**
```ts
function packContext(layout: ContextLayout, model?: string):
  { messages: Message[]; truncated: boolean; usage: { head: number; mid: number; tail: number } }
```

**compress(messages, options)**
```ts
function compress(messages: readonly Message[], options: CompressOptions): Promise<Message[]>
```
内置策略名：`'truncate'` | `'sliding-window'` | `'summarize'` | `'preserve-failures'`。

**analyzeCacheStability(v1, v2, model?)**
```ts
function analyzeCacheStability(v1: readonly Message[], v2: readonly Message[], model?: string): CacheStabilityReport
```

## 内部实现

### 打包策略

packContext 保证 HEAD 和 TAIL 始终包含，MID 段从前端（最旧消息）开始裁剪。这符合对话场景中"最近消息更重要"的假设。

### 压缩策略详解

| 策略 | 行为 |
|------|------|
| `truncate` | 从末尾向前保留，直到填满 budget |
| `sliding-window` | 保留最后 windowSize 条非 preserved 消息，再按 budget 裁剪 |
| `summarize` | 保留尾部消息，其余交给用户提供的 summarizer 回调生成摘要 |
| `preserve-failures` | 永远保留 `meta.isFailureTrace` 的消息，其余按 truncate 逻辑处理 |

所有策略都尊重 `preserve` 回调——被标记的消息不会被裁剪。

### 预算裁剪顺序

`trimOrder()` 返回按 trimPriority 降序排列的分段列表（数值最高的优先裁剪），reserved 分段和 used=0 的分段被排除。

### 缓存稳定性分析

逐消息比较两个数组（role + content + name + toolCallId + toolCalls），找到第一个分歧点，计算 `prefixMatchRatio = divergenceIndex / maxLength`，并根据比率生成优化建议。

## 依赖关系

- **依赖**: `core/types.ts`（Message 类型）、`core/errors.ts`（HarnessError）、`_internal/token-estimator.ts`
- **被依赖**: 无直接模块依赖

## 扩展点

- 实现 `CompressionStrategy` 接口自定义压缩策略，传入 compress() 的 strategy 参数
- 通过 `registerTokenizer()` 注册精确的模型 tokenizer（如 tiktoken）
- `preserve` 回调允许按业务规则保护特定消息

## 设计决策

1. **HEAD/MID/TAIL 布局**——对齐 KV-cache 最佳实践：稳定前缀（system prompt）在 HEAD，动态内容在 MID，最新消息在 TAIL
2. **裁剪 MID 而非 HEAD/TAIL**——系统指令和最新用户输入必须保留
3. **responseReserve**——预留输出 token 空间，避免输入占满整个上下文窗口

## 已知限制

- 默认 token 估算为 ~4 chars/token 启发式
- packContext 不支持基于消息优先级的选择性裁剪（仅按时间顺序）
- summarize 策略需要用户提供 summarizer 回调（不内置 LLM 调用）
