# Core — 变更历史

> Wave-by-wave 架构与实现的演进记录。当前的稳定参考见 [`01-core.md`](./01-core.md)。
> 每一节仅记录对 core 模块的相关变动；跨模块的发行说明请参考根 `CHANGELOG.md`。

## Wave-5B AgentLoop 模块分解（2026-04-15）

`agent-loop.ts` 原为 1268 LOC，`run()` 方法约 600 LOC 同时承担迭代控制、adapter 调用、流式翻译、重试退避、护栏钩子、span 埋点与钩子派发。Wave-5B 将其拆为 4 个协作模块，`run()` 收缩为 65 行编排骨架，实例上的 `_lastStreamErrorCategory` 侧信道被删除。

| 模块 | 职责 | 所有状态 | 对外导出 |
|------|------|---------|---------|
| `AgentLoop`（`agent-loop.ts`） | 实例生命周期、`status` / `usage` / `getMetrics()`、`run()` 编排、外部 signal 桥接、non-reentrancy 保护 | `_status` / `_iteration` / `cumulativeUsage` / `_totalToolCalls` / `abortController` | `AgentLoop` 类、`createAgentLoop` 工厂、`AgentLoopConfig` / `AgentLoopHook` / `AgentLoopTraceManager` 类型 |
| `IterationRunner`（`iteration-runner.ts`） | 单轮迭代：pre-iteration 预检（abort / max-iterations / token budget 由 orchestrator 处理后调用）、输入护栏、adapter 调用、工具分发、输出护栏、`bailOut` 终止事件合流 | **无**——每次运行由 orchestrator 分配 `IterationContext`；runner 本身是无状态工厂产物 | `createIterationRunner`、`IterationContext`、`IterationRunnerConfig`、`IterationOutcome`、`IterationRunner` 类型 |
| `AdapterCaller`（`adapter-caller.ts`） | 一次 adapter turn（`chat` 或 `stream`），内部实现重试 + 指数退避；将错误归一为 `AdapterCallResult` 判别联合 | 无（每次 `call()` 内部闭包） | `createAdapterCaller`、`AdapterCallOk` / `AdapterCallFail` / `AdapterCallResult`、`AdapterRetryInfo`、`AdapterCallerConfig`；`callOnce` 单次非重试入口保留 |
| `StreamHandler`（`stream-handler.ts`） | 消费 `adapter.stream()`、逐块 yield `text_delta` / `tool_call_delta` / `warning` / `error`、在失败前 yield `error` 事件再返回 `{ ok: false, errorCategory }` | 跨 `handle()` 无状态；每次 `handle()` 内新建 `StreamAggregator` | `createStreamHandler`、`StreamResult` 判别联合、`StreamHandlerConfig`、`StreamHandler` 类型 |
| `guardrail-helpers.ts` | 纯辅助：从消息数组取最新用户消息、从 `GuardrailResult` 选出导致阻塞的 guard 名称 | 无 | `findLatestUserMessage` / `pickBlockingGuardName` 函数 |

**设计约束（来自 ADR）**：

- `AdapterCaller` 是唯一重试所有者——`IterationRunner` 不再内联重试循环。
- `StreamHandler` 的 `StreamResult` 判别联合承载 `errorCategory` 字段，直接替代过去写到 `AgentLoop._lastStreamErrorCategory` 的实例侧信道；路径上恰好 yield 一次 `{ type: 'error' }` 事件（`AdapterCaller` 不再重复 yield）。
- `IterationRunner` 接收 orchestrator 分配的 `IterationContext`（conversation、iteration counter、cumulativeUsage、cumulativeStreamBytes、toolCallCounter 等可变 box），每次 `runIteration()` 后 `AgentLoop.run()` 把 context 字段回写到实例字段，保证 `getMetrics()` / `usage` getter 行为不变。
- `ExecutionStrategy.execute()` 的 `options` 收紧为 `Readonly<>`，允许 `AgentLoop` 在构造期冻结一次、每轮复用同一引用（PERF-025）。
- 原静态方法 `AgentLoop.categorizeAdapterError` 删除；`categorizeAdapterError` 作为具名导出由 `error-classifier.ts` 提供（`harness-one/core` 继续导出此符号）。

**公共 API 变更**：无。所有模块拆分对 `AgentLoop` / `createAgentLoop` / `AgentLoopConfig` / `AgentEvent` 等消费侧导出保持行为与签名不变；纯内部重构。

**设计文档**：`docs/forge-fix/wave-5/wave-5b-adr-v2.md`（设计决策与边界论证）、`wave-5b-adr-critique.md` / `wave-5b-review-redteam.md` / `wave-5b-review-synthesis.md`（评审记录）。

## Wave-5H 架构加固（2026-04-16）

对全代码库进行深度架构审查后的 23 项修复：

**输入验证**：
- `createParallelStrategy` 验证 `maxConcurrency >= 1`（防死锁）。
- `createCircuitBreaker` 验证 `failureThreshold >= 1` 和 `resetTimeoutMs >= 1`。
- `createFallbackAdapter` 拒绝空适配器数组。
- `pruneConversation` 安全处理 `maxMessages < 1`。
- `computeBackoffMs` 对负数 `attempt` 夹紧为 0。

**生产就绪**：
- `TraceManager` 中所有 `console.warn` 回退已移除——库代码不再直接写 stderr。导出错误路由到注入的 `logger` 或 `onExportError`；两者都缺失时静默吞咽。
- `CostTracker.alertHandlers` 从 Array 改为 Set（O(1) 退订，与 session/orchestrator 一致）。
- 护栏管线超时定时器增加 `.unref()` 防止进程挂起。

**并发安全**：
- `FallbackAdapter.handleSuccess()` 现在在 `switchLock` 内执行（防止与并发 failure 竞争）。
- `createParallelStrategy` 在每个工具调用前检查 abort signal。

**API 一致性**：
- `SessionManager.list()` 不再返回已过期会话（之前泄露内部状态）。
- `SessionManager.activeSessions` 简化为 O(1)。
- `RAGPipeline.clear()` 同步重置 `getIngestMetrics()` 计数器和 retriever 索引。
- `HarnessLifecycle` 新增 `dispose()` 方法释放健康检查引用。

## Wave-8 Production Hardening（2026-04-16）

1. **JSON Schema 递归深度限制**：`validate()` 现在强制 `MAX_VALIDATION_DEPTH=64` 的递归深度上限，防止病态 schema（如深度嵌套的 `$ref` 或递归定义）导致的栈溢出。

## Wave-9 Deep Architecture Audit（2026-04-16）

跨 6 个维度的全面架构审计，产出 18 项生产级修复：

### Core 模块
1. **工具执行错误信息增强**：`execution-strategies.ts` 中 catch 块现在保留 `errorName` 字段，便于下游区分错误类型。Stack trace 被有意排除以遵守 F14 安全策略（防止泄漏到 LLM）。
2. **工具结果序列化性能优化**：`iteration-runner.ts` 中 `safeStringifyToolResult` 的循环引用检测从 O(n²) 的 `Array.includes()` 改为 O(1) 的 `WeakSet`。
3. **dispose() 状态翻转时序修正**：`agent-loop.ts` 中 `dispose()` 现在在 `finally` 块中设置 `_status = 'disposed'`，确保清理逻辑异常时状态仍正确转换。
4. **createAgentLoop 工厂一致性**：preset 包现在统一使用 `createAgentLoop()` 而非 `new AgentLoop()`，与 ARCH-011 工厂模式对齐。

### Session 模块
5. **lock() TTL 检查**：`session/manager.ts` 中 `lock()` 现在在加锁前检查 TTL，防止锁定已过期的 session。
6. **事件处理器迭代安全**：queued event 处理循环改为迭代 handler 快照，防止 handler 在迭代期间修改集合。

### 观测模块
7. **TraceManager 品牌类型**：`startSpan`/`addSpanEvent`/`setSpanAttributes`/`endSpan`/`endTrace`/`getTrace` 等方法参数增加 `TraceId | string` / `SpanId | string` 联合类型。
8. **eviction 重入保护增强**：eviction 循环改为两遍制，捕获首轮 eviction 期间新增的 trace。

### Preset 模块
9. **新增 baseRetryDelayMs / maxAdapterRetries 验证**：`createHarness()` 现在拒绝非法的重试配置。
10. **shutdown 序列 logger 防护**：shutdown DAG 中所有 `logger.warn()` 调用均包裹 try/catch，防止 logger 异常中断关闭流程。
11. **env.ts 严格数值解析**：环境变量解析从 `parseInt` 改为 `Number()`，拒绝 `"5abc"` 等部分解析值。
12. **SecurePreset lifecycle 时序修正**：`shutdown()`/`drain()` 中 `completeShutdown()` 移入 `finally` 块。

### RAG 模块
13. **文档加载器输入验证**：`createTextLoader` 在加载时校验所有元素为 string 类型。
14. **嵌入维度不匹配抛错**：`dotProduct` 现在在维度不匹配时抛出 `RAG_EMBEDDING_MISMATCH` 而非静默返回 0。
15. **缓存键转义**：retriever 缓存键中的管道符 `|` 和反斜杠现在正确转义，防止多租户场景下的键碰撞。

### Guardrail / Rate Limiter
16. **pipeline 配置数组 readonly**：`createPipeline` 的 `input`/`output` 配置改为 `readonly` 数组。
17. **rate-limiter eviction 回调日志**：新增可选 `logger` 参数，eviction 回调异常时通过 logger 输出而非静默吞噬。

### Memory 模块
18. **relay 腐败数据可见性**：`createRelay` 新增可选 `logger` 参数，无 `onCorruption` 回调时通过 logger 输出腐败警告。

## Wave-10 深度架构审计修复（2026-04-16）

基于 UltraDeep 架构审计报告的 27 项全面修复，覆盖 3 个严重级别（Critical/High/Medium/Low）：

**Critical 修复**：
- `AgentPool`: `monotonicCreatedAt` 和 `drain()` 改用 `performance.now()` 单调时钟——修复 NTP/DST 时钟偏移导致的 agent 过期异常（F2/F20）。
- `SessionManager`: `_droppedEvents` 计数器通过 `droppedEvents` getter 公开；首次丢弃时通过 logger 发出警告（F3/F23）。
- `ContextRelay`: 新增 `readonly version` getter 暴露乐观并发版本号（relay 已内置 `updateWithGuard` + `MEMORY_RELAY_CONFLICT`）（F4）。

**High 修复**：
- `AgentLoop`: 新增 `strictHooks?: boolean` 配置——`true` 时 hook 异常上抛而非静默吞咽；`false` 仍保留现有行为但确保通过 logger/console.error 输出（F5）。
- `StreamAggregator`: 新增 `maxToolCalls?: number`（默认 128）——超出限制时 yield error 事件，与 OpenAI 适配器的 `MAX_TOOL_CALLS` 对齐（F6）。
- `CircuitBreaker`: `onStateChange` 回调包裹 try/catch——回调异常不再破坏状态转换（F7）。
- `LazyAsync`: 引入 `generation` 计数器——`reset()` 递增 generation，rejection handler 仅在 generation 匹配时清除缓存，消除竞态（F9）。
- `AsyncLock`: 新增 `dispose()` 方法——reject 所有排队 waiter 并阻止后续 acquire（F17）。

**Medium 修复**：
- `TraceManager`: 采样决策移至 `startTrace()` 时刻——trace context 记录 `sampled: boolean`，`endTrace()` 尊重已存决策（F12）。
- `MemoryStore.writeBatch`: 已确认实现正确（validate-first + rollback），补充了原子性测试（F13）。
- `tools/registry.ts`: TOOL_NAME_RE 错误消息现在明确提及下划线和点号（F21）。
- `GuardrailPipeline`: `BoundedEventBuffer` 新增 `evictedCount` getter（F3b）。
