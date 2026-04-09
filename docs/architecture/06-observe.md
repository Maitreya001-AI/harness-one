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
TraceManager 接口：`startTrace()`, `startSpan()`, `addSpanEvent()`, `setSpanAttributes()`, `endSpan()`, `endTrace()`, `getTrace()`, `flush()`.

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
CostTracker 接口：`setPricing()`, `recordUsage()`, `getTotalCost()`, `getCostByModel()`, `getCostByTrace()`, `setBudget()`, `checkBudget()`, `onAlert()`, `reset()`.

## 内部实现

### Trace/Span 生命周期

Trace 内部维护 MutableTrace/MutableSpan 结构（可写），通过 `toReadonlyTrace()` 转为只读快照返回。Span 结束时异步调用所有 exporter（catch 吞掉错误），Trace 结束时导出完整 trace。

### LRU 淘汰

`maxTraces` 控制内存中的最大 trace 数量。新 trace 创建时检查是否超限，超限则按 FIFO 顺序淘汰最旧的 trace 及其所有 span。

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

1. **Exporter 异步且不阻塞**——exportTrace/exportSpan 的 Promise rejection 被静默吞掉，不影响业务流程
2. **LRU 而非 TTL**——按数量而非时间淘汰，更适合长期运行的 agent 进程
3. **成本与追踪分离**——TraceManager 和 CostTracker 是独立的，可单独使用

## 已知限制

- Exporter 错误被静默忽略，无错误回调
- TraceManager 不支持跨进程的分布式追踪关联
- CostTracker 的记录数组只增不减（除非手动 reset）
- 未注册模型的成本计算为 0，不发出警告
