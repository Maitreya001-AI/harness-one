# Observe

> 可观测性：Trace/Span 管理、成本追踪、预算告警、导出器、默认 redaction、safe-log 原语。

## Wave-5A: Secure-by-default redaction (1.0-rc)

**默认启用**（T02/T03/T04）：
- `createLogger()` 无参默认 `useDefaultPattern: true`——scrub `api_key`/`token`/`password`/`authorization` 等
- `createTraceManager()` 同上——span attributes、trace metadata、span events 默认 redacted
- `langfuseExporter.exportSpan` 默认 `sanitize = sanitizeAttributes(attrs, defaultRedactor())`

**关 redaction 的逃生门**：
- Logger / TraceManager 接受 `redact: false`
- Langfuse exporter 不接受 `sanitize: false`——必须提供**替代函数**（强制显式）

**`infra/safe-log.ts`（T01）**：新增 `createDefaultLogger()`（redaction-on console 包装）+
`safeWarn(logger?, msg, meta)` / `safeError(logger?, msg, meta)` 消除 `logger ?? console.warn`
boilerplate。

## 概述

observe 模块提供两个核心能力：TraceManager 管理分布式追踪（Trace + Span 层级，支持事件和属性，带 LRU 淘汰和可插拔 Exporter）；CostTracker 追踪 token 使用成本（按模型定价、按 trace 聚合、预算告警）。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/observe/types.ts` | 类型定义：Trace、Span、SpanEvent、TokenUsageRecord、CostAlert、TraceExporter | ~67 |
| `src/observe/trace-manager.ts` | createTraceManager + createConsoleExporter + createNoOpExporter；trace/span ID 使用 `prefixedSecureId` 生成（SEC-002） | ~273 |
| `src/observe/cost-tracker.ts` | createCostTracker——成本追踪与预算告警；警告通过 `safeWarn` 结构化日志输出（不再直接 `console.warn`） | ~177 |
| `src/observe/lifecycle.ts` | HarnessLifecycle 状态机：init → ready → draining → shutdown；聚合健康检查（Wave-5D ARCH-6） | ~119 |
| `src/observe/metrics-port.ts` | MetricsPort 接口：vendor-neutral counter/gauge/histogram + createNoopMetricsPort（Wave-5D ARCH-5） | ~65 |
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
| `SpanAttributeValue` | 允许的 attr 值类型（0.2.0）：`string \| number \| boolean \| readonly string[] \| readonly number[] \| readonly boolean[]`，与 OTel 语义兼容 |
| `SpanAttributes` | `Readonly<Record<string, SpanAttributeValue>>`（0.2.0）；新代码应使用此类型，接口层兼容仍为 `Record<string, unknown>` |
| `TokenUsageRecord` | token 用量记录：含 estimatedCost 和 timestamp |
| `CostAlert` | 成本告警：type (warning/critical)、currentCost、budget、percentUsed |
| `TraceExporter` | 导出器接口：exportTrace、exportSpan、flush + 可选生命周期方法 |
| `ModelPricing` | 模型定价：input/output/cacheRead/cacheWrite 每千 token 价格 |

### 工厂函数

**createTraceManager(config?)**
```ts
function createTraceManager(config?: {
  exporters?: TraceExporter[];
  maxTraces?: number;            // 默认 1000，LRU 淘汰；非正数值在构造时被拒绝
  onExportError?: (err: unknown) => void;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }; // 0.2.0
  defaultSamplingRate?: number;  // 0.2.0，[0, 1]，默认 1（全采）
}): TraceManager
```
TraceManager 接口：`startTrace()`, `startSpan()`, `addSpanEvent()`, `setSpanAttributes()`, `endSpan()`, `endTrace()`, `getTrace()`, `getActiveSpans()`, `flush()`, `initialize()` (0.2.0)、`setSamplingRate(rate)` (0.2.0)、`dispose()`.

- `initialize(): Promise<void>` — 主动调用每个 exporter 的 `initialize?()`。未调用时首个导出触发懒加载。
- `setSamplingRate(rate)` — 运行时调节全局采样率，接受 [0, 1]。per-exporter `shouldExport()` 优先级更高。
- `flush() / dispose()` — **都会等待所有 in-flight span/trace 导出落地**（0.2.0 修复：此前 `flush()` 只让 exporter 自身 flush，外层仍有未 settle 的 `.then()` 链）。
- `getActiveSpans(olderThanMs?)` — 返回仍处于 'running' 状态的 span，用于检测泄漏。
- `startSpan()` 的 parentId 必须是同一 trace 中已存在的 span，否则抛出 `SPAN_NOT_FOUND`。

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
  alertThresholds?: { warning: number; critical: number };  // 默认 0.8 / 0.95
  maxRecords?: number;  // 环形缓冲区容量上限，默认 10,000
  maxModels?: number;   // modelTotals 二级索引上限，默认 1000，FIFO 淘汰
  maxTraces?: number;   // traceTotals 二级索引上限，默认 10,000，FIFO 淘汰
  strictMode?: boolean;          // 0.2.0，默认 false
  warnUnpricedModels?: boolean;  // 0.2.0，默认 true
}): CostTracker
```

- `strictMode: true`：`recordUsage()` 收到 `model` 缺失或 `inputTokens/outputTokens` 非有限数时抛 `HarnessError('INVALID_INPUT')`。适合测试期暴露 adapter 上报数据的缺陷。生产默认关闭以保持向后兼容。
- `warnUnpricedModels: true`（默认）：首次看到未注册定价的 model 时打一条 `console.warn`，指向 `setPricing()`。同一 model 只警告一次。避免"cost 全为 0 却不知道为什么"这种盲点。
CostTracker 接口：`setPricing()`, `recordUsage()`, `updateUsage()`, `getTotalCost()`, `getCostByModel()`, `getCostByTrace()`, `setBudget()`, `checkBudget()`, `onAlert()`, `getAlertMessage()`, `reset()`.

`updateUsage(traceId, partialUsage)` 用于流式场景：当 token 用量随流式响应逐步累积时，可多次调用此方法更新同一 traceId 的用量，而无需在流结束后一次性 `recordUsage()`。最终成本基于累积的完整用量计算。

实现特点：
- 使用独立闭包函数（checkBudgetFn、getAlertMessageFn）代替 `this` 引用，支持安全解构：`const { recordUsage, checkBudget } = createCostTracker()`
- 环形缓冲区容量由 `maxRecords` 配置（默认 10,000），超出时自动淘汰最旧记录
- `modelTotals` / `traceTotals` 二级索引提供 O(1) 的 `getCostByModel()` / `getCostByTrace()` 查询；容量由 `maxModels` / `maxTraces` 限制，超出时 FIFO 淘汰最早键
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

`TraceExporter` 接口除必选的 `exportTrace()`、`exportSpan()`、`flush()` 外，有四个可选生命周期方法——**从 0.2.0 起全部由 TraceManager 真正调用**（此前仅 `shutdown?()` 被 `dispose()` 使用，其余三个声明但未实现，构成契约残缺）：

| 方法 | 调用时机（0.2.0） |
|------|-------------------|
| `initialize?()` | 懒调用——首个 `exportTrace`/`exportSpan` 触发；或调用方主动 `tm.initialize()` 一次性预热 |
| `isHealthy?()` | 每次导出前检查；返回 `false` 时跳过该 exporter 的本次导出 |
| `shouldExport?(trace)` | `endTrace` 时对该 exporter 询问是否导出此 trace（sampling / attribute 过滤） |
| `shutdown?()` | `tm.dispose()` 时调用 |

**全局 sampling（Wave-10 F12 更新）**：采样决策在 `startTrace()` 时刻做出（`Math.random() < rate`），结果存储在 trace context 的 `sampled: boolean` 字段上。`endTrace()` 尊重已存决策，不再重新掷骰。运行时通过 `setSamplingRate()` 调整仅影响新启动的 trace，已启动的 trace 不受影响。per-exporter `shouldExport?()` 优先级仍高于全局 sampling。

**懒初始化容错**：`initialize()` 失败时错误通过 `onExportError` / logger 报告，但不会永久阻塞后续 exportSpan/exportTrace 调用——每次导出仍会尝试 awaitting 缓存的 `initialize()` promise（已 settled），避免 exporter 因初次连接失败从此下线。

## 扩展点

- 实现 `TraceExporter` 接口对接外部 APM（如 Datadog、Jaeger），利用生命周期方法管理连接和采样
- 通过 `ModelPricing` 配置任意模型的定价
- `onAlert()` 回调可触发自动降级或切换模型

## OTel Attribute Conventions

harness-one 自身使用 `harness.*` 命名空间来标记内部 trace/span 身份，避免与 OpenTelemetry 语义约定冲突。导出到 OTel 时这些属性原样保留。

**命名空间**：`harness.*`

| 属性键 | 含义 | 何时设置 |
|--------|------|----------|
| `harness.trace.id` | harness-one 内部 trace ID（TraceManager 分配） | 每个 span 自动携带；用于反查 `tm.getTrace(id)` |
| `harness.span.id` | harness-one 内部 span ID | 每个 span 自动携带 |
| `harness.parent.id` | 父 span 的 `harness.span.id` | 子 span 创建时写入；根 span 缺省 |

> 不要把这些键用作业务数据——它们是诊断标识符，SRE 用来关联 `Trace` 快照与 exporter 落地的 OTel span。

### CacheMonitor -> OTel semconv 映射

CacheMonitor 历史上暴露的指标键（`hitRate`、`missRate`、`avgLatency`）与 OpenTelemetry 语义约定不一致。`@harness-one/opentelemetry` exporter 在写入 span attributes 时自动重命名：

| harness-one 原名 | OTel semconv 名 | 单位/含义 |
|-----------------|-----------------|-----------|
| `hitRate` | `cache.hit_ratio` | 0–1，缓存命中率 |
| `missRate` | `cache.miss_ratio` | 0–1，缓存未命中率 |
| `avgLatency` | `cache.latency_ms` | 毫秒，平均延迟 |

重命名只作用于 primitive 值；非 primitive（对象/数组）被 exporter 丢弃并计入 `getDroppedAttributeMetrics()`。下游仪表盘（Grafana、Honeycomb 查询）统一按 OTel 名读取即可。

新代码在自定义 exporter 中应直接使用 `cache.*` 名称，避免依赖 rename 机制。

## harness.run() 的 trace 布局（0.2.0）

当使用 `@harness-one/preset` 的 `createHarness()` 时，`harness.run()` 会为每次调用创建一个**顶层 trace** `harness.run`，并把以下内容挂在它下面：

- **顶层 span**：`harness.run` 自身携带 `sessionId`、`messageCount` metadata。
- **guardrail 子 span**：每次守卫检查启动一个名为 `guardrail:input` / `guardrail:tool-args` / `guardrail:output` / `guardrail:tool-result` 的 span，属性含 `passed`、`verdict`、`latencyMs`、可选 `reason`（被拦时）。失败的守卫 span 以 `'error'` 状态结束。
- **iteration-N span**：由内部 AgentLoop 创建（和普通 loop 使用相同的 TraceManager），属性在 `01-core.md` 里列出。
- **tool:&lt;name&gt; span**：每次工具调用一个子 span。

因此，一次线上事故的 trace 链路为：`harness.run` → `guardrail:input` → `iteration-1` → `tool:search` → `guardrail:tool-result` → `iteration-2` → ... → `guardrail:output` → 结束。SRE 可以按属性过滤"今天哪些 session 被 guardrail 拦了"、"哪个工具失败最多"、"rate-limit retry 次数最高的 trace 是哪条"。

## 设计决策

1. **Exporter 异步且不阻塞**——exportTrace/exportSpan 的 Promise rejection 通过 `onExportError` 回调报告，不影响业务流程
2. **LRU 而非 TTL**——按数量而非时间淘汰，更适合长期运行的 agent 进程
3. **成本与追踪分离**——TraceManager 和 CostTracker 是独立的，可单独使用
4. **契约与实现对齐（0.2.0）**——TraceExporter 接口声明的生命周期钩子全部由 TraceManager 真正调用；避免"声明即谎言"的契约残缺

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
| `thresholds.toolLoopMinRun` | `number` | `3` | 触发 `tool_loop` 所需的最小连续同名 Span 数 |
| `thresholds.earlyStopMaxSpans` | `number` | `2` | `early_stop` 检测的 Span 数上限（超过此值不触发） |
| `thresholds.budgetExceededConfidence` | `number` | `0.9` | `budget_exceeded` 的基础置信度（0–1） |

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

## Wave-8 Production Hardening

1. **Lifecycle markReadyAfterHealthCheck()**：新增异步方法 `markReadyAfterHealthCheck()`，在状态转换为 ready 之前先运行所有已注册的健康检查，若任一组件状态为 `'down'` 则拒绝转换（reject），确保系统不会在组件异常时进入就绪状态。
2. **成本追踪器防篡改**：`updateUsage()` 现在拒绝降低 token 计数的尝试（即 inputTokens 或 outputTokens 不允许减少），防止通过回溯性缩减用量来操控成本数据。

## 已知限制

- TraceManager 不支持跨进程的分布式追踪关联
- 未注册模型的成本计算为 0，不发出警告
- getCostByModel()/getCostByTrace() 仅反映缓冲区内的记录；如需包含已淘汰记录的累计总额，使用 getTotalCost()
- FailureTaxonomy 仅分析 Trace 结构，不检查消息内容
- CacheMonitor 的成本节约估算依赖用户提供准确的 pricing 配置
