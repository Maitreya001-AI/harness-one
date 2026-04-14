# Wave-5D · Observability Canonical + Lifecycle + 状态一致性

**状态**: pending · **依赖**: Wave-5C 合入 · **估时**: 2-3 周（**需 PRD + ADR**）

## 目标

OpenTelemetry 为 canonical 观测栈；引入 `MetricsPort` 与 `InstrumentationPort` 并列；
显式 lifecycle 状态机 + `Harness.health()`；conversation source-of-truth + 对账器；
全局 `AdmissionController`/`TokenBucket` 背压 + adapter 级 circuit breaker。

## 范围（Findings）

- **ARCH-5** trace-heavy / metric-absent；OTel + Langfuse 双实现冲突；`CostTracker` 双账本
- **ARCH-6** Harness 是 13 子系统的袋子，无 `ready()`/`isHealthy()`/`drain()` 明确状态
- **ARCH-7** session + memory + conversation 三库非事务（崩溃后 tool 副作用双写）
- **ARCH-8** 无全局并发预算/租户限流/背压；429 重试风暴放大
- **m-6** LangFuse exporter 自前 LRU + core trace-manager LRU 熵不一致

## 决策（已在 Wave-5 决策文档定）

- **OTel canonical**，Langfuse 降级为辅配 `TraceExporter`（+ 可选 `MetricExporter` 桥接）
- **多租户 in-scope**

## 流程（完整 spec-kit）

1. **PRD** → 技术怀疑者挑战
   - OTel Metrics API vs 自定义 `MetricsPort`？（可能都要，前者是实现细节）
   - Conversation source-of-truth 是否可接受 append-only 不可变？
   - AdmissionController 跨进程（Redis TokenBucket）还是 in-process？
2. **3 方案竞争** + 裁决
3. **ADR**：
   - `MetricsPort` 契约（counter/gauge/histogram）+ OTel Metrics 绑定
   - 成本账本归属（core 单一源，Langfuse 读视图）
   - lifecycle 状态机：`init → ready → draining → shutdown`
   - `Harness.health(): { exporter, adapter, store, pool }` 聚合
   - 对账器触发策略：boot 时 + 定时巡检 + 手动 trigger
   - `AdmissionController` 接口 + per-tenant quota + backoff
4. `task-planner` + `risk-assessor`
5. `team-implementer`×5
6. 审查 + 验收

## 需要你拍板的事

- 是否真删 core `CostTracker`（改为 OTel Histogram 聚合）？还是保留作为域聚合器？
- Redis TokenBucket 依赖是否接受（引入 @harness-one/redis 作为运行时依赖）？
- 对账器冲突策略：conversation 胜 vs memory 胜 vs alert 手动介入？

## 关键文件

- 新建: `packages/core/src/observe/metrics-port.ts`
- 新建: `packages/core/src/_internal/admission-controller.ts`（或 `infra/`，如 Wave-5C 完成）
- `packages/core/src/observe/cost-tracker.ts`（可能大改或删）
- `packages/core/src/session/conversation-store.ts`
- `packages/core/src/memory/store.ts` + `packages/core/src/memory/relay.ts`
- 新建: `packages/core/src/memory/reconciler.ts`
- `packages/preset/src/index.ts`（lifecycle 状态机 + health）
- `packages/opentelemetry/src/index.ts`（MetricExporter 桥）
- `packages/langfuse/src/index.ts`（降级为辅配）

## 风险提示

- 对账器设计错误会静默吞状态（必须先写故障注入测试再做实现）
- 跨进程 TokenBucket 的 Redis 依赖需要优雅降级（redis down → fall back to per-process）
