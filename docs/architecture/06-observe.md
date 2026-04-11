# Observe

> 可观测性：Trace/Span 管理、成本追踪、预算告警、导出器。

## 概述

observe 模块提供两个核心能力：TraceManager 管理分布式追踪（Trace + Span 层级，支持事件和属性，带 LRU 淘汰和可插拔 Exporter）；CostTracker 追踪 token 使用成本（按模型定价、按 trace 聚合、预算告警）。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/observe/types.ts` | 类型定义：Trace、Span、SpanEvent、TokenUsageRecord、CostAlert、TraceExporter | ~67 |
| `src/observe/trace-manager.ts` | createTraceManager + createConsoleExporter + createNoOpExporter | ~273 |
| `src/observe/cost-tracker.ts` | createCostTracker——成本追踪与预算告警 | ~177 |
| `src/observe/failure-taxonomy.ts` | createFailureTaxonomy——从 Trace 分类失败模式 | ~189 |
| `src/observe/cache-monitor.ts` | createCacheMonitor——KV-cache 命中率监控 | ~133 |
| `src/observe/index.ts` | 公共导出桶文件 | ~20 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `Trace` | 追踪：id、name、startTime、endTime、metadata、spans、status |
| `Span` | 跨度：id、traceId、parentId、name、attributes、events、status |
| `SpanEvent` | 跨度事件：name、timestamp、attributes |
| `TokenUsageRecord` | token 用量记录：含 estimatedCost 和 timestamp |
| `CostAlert` | 成本告警：type (warning/critical)、currentCost、budget、percentUsed |
| `TraceExporter` | 导出器接口：exportTrace、exportSpan、flush + 可选生命周期方法 |
| `ModelPricing` | 模型定价：input/output/cacheRead/cacheWrite 每千 token 价格 |

### 工厂函数

**createTraceManager(config?)**
```ts
function createTraceManager(config?: {
  exporters?: TraceExporter[];
  maxTraces?: number;  // 默认 1000，LRU 淘汰
}): TraceManager
```
TraceManager 接口：`startTrace()`, `startSpan()`, `addSpanEvent()`, `setSpanAttributes()`, `endSpan()`, `endTrace()`, `getTrace()`, `getActiveSpans()`, `flush()`, `dispose()`.

- `getActiveSpans(): Array<{ id: string; traceId: string; name: string; startTime: number }>` — 返回仍处于 'running' 状态的 span，用于检测泄漏的 span。
- `dispose(): Promise<void>` — 执行 flush + shutdown + 清理所有内部状态。
- `startSpan()` 的 parentId 参数现在会被校验——如果提供了 parentId，必须是同一 trace 中已存在的 span，否则抛出 SPAN_NOT_FOUND 错误。

**createConsoleExporter(config?)** / **createNoOpExporter()**
```ts
function createConsoleExporter(config?: { verbose?: boolean }): TraceExporter
function createNoOpExporter(): TraceExporter
```

**createCostTracker(config?)**
```ts
function createCostTracker(config?: {
  pricing?: ModelPricing[];
  budget?: number;
  alertThresholds?: { warning: number; critical: number };  // 默认 0.8 / 0.95（Langfuse 实现中可通过 config 覆盖）
}): CostTracker
```
CostTracker 接口：`setPricing()`, `recordUsage()`, `updateUsage()`, `getTotalCost()`, `getCostByModel()`, `getCostByTrace()`, `setBudget()`, `checkBudget()`, `onAlert()`, `getAlertMessage()`, `reset()`.

`updateUsage(traceId, partialUsage)` 用于流式场景：当 token 用量随流式响应逐步累积时，可多次调用此方法更新同一 traceId 的用量，而无需在流结束后一次性 `recordUsage()`。最终成本基于累积的完整用量计算。

实现特点：
- 使用独立闭包函数（checkBudgetFn、getAlertMessageFn）代替 `this` 引用，支持安全解构：`const { recordUsage, checkBudget } = createCostTracker()`
- 内置 maxRecords=10,000 环形缓冲区，超出时自动淘汰最旧记录
- 每 1,000 条记录执行一次浮点数重校准，防止精度漂移
- `getAlertMessage(): string | null` — 返回当前预算告警的人类可读消息，无告警时返回 null

## 内部实现

### Trace/Span 生命周期

Trace 内部维护 MutableTrace/MutableSpan 结构（可写），通过 `toReadonlyTrace()` 转为只读快照返回。Span 结束时异步调用所有 exporter（错误通过 `onExportError` 回调报告），Trace 结束时导出完整 trace。

### LRU 淘汰

`maxTraces` 控制内存中的最大 trace 数量。新 trace 创建时检查是否超限，超限则按 FIFO 顺序淘汰最旧的 trace 及其所有 span。淘汰逻辑包裹在 `try-finally` 块中，确保即使淘汰过程中发生异常，内部状态（tracks Map、accessOrder）也能正确清理，不留悬空引用。

### ID 生成

`id-{counter}-{Date.now().toString(36)}` 格式，单进程内唯一。

### 成本计算

`recordUsage()` 根据注册的 ModelPricing 计算：
```
cost = (inputTokens/1000 * inputPrice) + (outputTokens/1000 * outputPrice)
     + (cacheReadTokens/1000 * cacheReadPrice) + (cacheWriteTokens/1000 * cacheWritePrice)
```
未注册模型的成本为 0。

### 预算告警

每次 `recordUsage()` 后自动检查预算。`percentUsed >= critical` 触发 critical 告警，`>= warning` 触发 warning 告警。默认阈值 0.8 / 0.95，可通过 config 自定义。告警通过 `onAlert()` 注册的回调分发。

## 依赖关系

- **依赖**: `core/errors.ts`（HarnessError）
- **被依赖**: 无直接模块依赖

## TraceExporter 生命周期方法

`TraceExporter` 接口除必选的 `exportTrace()`、`exportSpan()`、`flush()` 外，新增四个可选生命周期方法：

| 方法 | 说明 |
|------|------|
| `initialize?()` | 初始化导出器（如建立后端连接）。在首次导出前调用 |
| `isHealthy?()` | 同步健康检查，返回 `false` 时可跳过导出或触发告警 |
| `shouldExport?(trace)` | 采样控制——返回 `false` 时跳过该 trace 的导出。用于实现概率采样或基于属性的过滤 |
| `shutdown?()` | 优雅关闭（如刷新缓冲区、断开连接） |

所有方法均为可选，已有的 exporter 实现无需修改。

## 扩展点

- 实现 `TraceExporter` 接口对接外部 APM（如 Datadog、Jaeger），利用生命周期方法管理连接和采样
- 通过 `ModelPricing` 配置任意模型的定价
- `onAlert()` 回调可触发自动降级或切换模型

## 设计决策

1. **Exporter 异步且不阻塞**——exportTrace/exportSpan 的 Promise rejection 通过 `onExportError` 回调报告，不影响业务流程
2. **LRU 而非 TTL**——按数量而非时间淘汰，更适合长期运行的 agent 进程
3. **成本与追踪分离**——TraceManager 和 CostTracker 是独立的，可单独使用

## Failure Taxonomy

> 从 Trace 结构自动分类 Agent 失败模式。

### 概述

`createFailureTaxonomy()` 分析已完成的 Trace，通过一组可插拔的 FailureDetector 识别常见失败模式（如工具循环、过早停止、预算超支）。每个检测器独立评分，返回按置信度降序排列的分类结果。

### 工厂函数

```ts
function createFailureTaxonomy(config?: FailureTaxonomyConfig): FailureTaxonomy
```

**配置项**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `detectors` | `Record<string, FailureDetector>` | — | 覆盖或扩展内置检测器 |
| `minConfidence` | `number` | `0.5` | 低于此阈值的检测结果不报告 |

### 5 个内置检测器

| 模式 | 触发条件 | 基础置信度 |
|------|---------|-----------|
| `tool_loop` | ≥3 个连续同名 Span | 0.5 + (runLength - 3) × 0.1，上限 0.95 |
| `early_stop` | 已完成 Trace，≤2 Span，<5s | 0.6 |
| `budget_exceeded` | 最后一个 Span 为 error 且名称/属性含 "budget" | 0.9 |
| `timeout` | Trace >120s，最后一个 Span 仍为 running | 0.8 |
| `hallucination` | ≥2 个 tool 相关 Span 为 error | 0.5 + errorCount × 0.1，上限 0.8 |

### API

| 方法 | 说明 |
|------|------|
| `classify(trace)` | 分析 Trace，返回 `FailureClassification[]`（按 confidence 降序） |
| `registerDetector(mode, detector)` | 运行时注册自定义检测器 |
| `getStats()` | 返回各失败模式的累计计数 |
| `reset()` | 重置累计统计 |

### 扩展

实现 `FailureDetector` 接口（`detect(trace): { confidence, evidence } | null`），通过 config 或 `registerDetector()` 注入。自定义检测器可覆盖同名内置检测器。

## Cache Monitor

> KV-cache 命中率监控与成本节约估算。

### 概述

`createCacheMonitor()` 追踪 LLM 调用的缓存命中率，提供运行聚合指标和时间序列分桶数据，用于评估上下文工程策略的缓存效果。

### 工厂函数

```ts
function createCacheMonitor(config?: CacheMonitorConfig): CacheMonitor
```

**配置项**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `pricing.cacheReadPer1kTokens` | `number` | `0` | 缓存读取每千 token 价格 |
| `pricing.inputPer1kTokens` | `number` | `0` | 常规输入每千 token 价格 |
| `maxBuckets` | `number` | `100` | 保留的原始数据点上限为 maxBuckets × 10 |

### API

| 方法 | 说明 |
|------|------|
| `record(usage, prefixMatchRatio?)` | 记录一次 token 用量样本。可选传入 `prefixMatchRatio` 覆盖自动计算的命中率 |
| `getMetrics()` | 返回聚合指标：totalCalls、avgHitRate、totalCacheReadTokens、totalCacheWriteTokens、estimatedSavings |
| `getTimeSeries(bucketMs?)` | 返回按时间分桶的指标数组（默认 60s 桶） |
| `reset()` | 清空所有记录数据 |

### 实现细节

- **从原始数据重算聚合** —— `getMetrics()` 每次从原始数据点重新计算，避免浮点漂移
- **成本节约估算** —— `estimatedSavings = cacheReadTokens × (inputPrice - cacheReadPrice) / 1000`，下限为 0
- **数据淘汰** —— 原始数据点超过 `maxBuckets × 10` 时，从最旧端淘汰

## 已知限制

- TraceManager 不支持跨进程的分布式追踪关联
- 未注册模型的成本计算为 0，不发出警告
- getCostByModel()/getCostByTrace() 仅反映缓冲区内的记录；如需包含已淘汰记录的累计总额，使用 getTotalCost()
- FailureTaxonomy 仅分析 Trace 结构，不检查消息内容
- CacheMonitor 的成本节约估算依赖用户提供准确的 pricing 配置
