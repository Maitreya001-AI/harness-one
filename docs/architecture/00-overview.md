# harness-one 架构总览

> **Agent = Model + Harness.** harness-one 提供 Harness 层的通用基础设施。

## 定位

harness-one 是一个 TypeScript 工具库，为 AI Agent 产品提供 Harness Engineering 的通用原语。覆盖参考架构的 9 个层次，以 10 个独立模块 + 1 个 CLI 工具的形式交付。自 2026-04 起，新增多 Agent 编排基础设施（Agent Pool、Handoff Protocol、Context Boundary），将单 Agent 架构扩展至多 Agent 协作场景。

**不是框架**——不强制 pipeline 流程，不绑定 LLM 提供商，不管理部署。用户自由组合所需模块。

## 核心数据

| 指标 | 值 |
|------|---|
| 源码文件 | ~78 个 .ts 文件 |
| 测试文件 | ~57 个 .test.ts 文件 |
| 测试用例 | 1,480+ |
| 源码行数 | ~10,500 行 |
| 运行时依赖 | 0 |
| 模块数 | 10 核心模块 + 7 集成包 + 1 full 包 |
| 包结构 | pnpm monorepo with 10 packages |
| 构建目标 | Node.js >= 18, ESM + CJS |

## 9 层参考架构映射

| 层 | 参考架构 | harness-one 模块 | 子路径 |
|----|---------|-----------------|--------|
| ① | Agent Loop | **core** | `harness-one/core` |
| ② | 上下文工程 | **context** | `harness-one/context` |
| — | Prompt 工程 | **prompt** | `harness-one/prompt` |
| ③ | 工具系统 | **tools** | `harness-one/tools` |
| ④ | 安全与护栏 | **guardrails** | `harness-one/guardrails` |
| ⑤ | 记忆与持久化 | **memory** | `harness-one/memory` |
| ⑥ | 评估与验证 | **eval** | `harness-one/eval` |
| ⑦ | 可观测性 | **observe** | `harness-one/observe` |
| ⑧ | 持续演进 | **evolve** | `harness-one/evolve` |
| ⑨ | 熵回收 | **evolve** (合并) | `harness-one/evolve` |
| — | 会话管理 | **session** | `harness-one/session` |
| ⑩ | 多 Agent 编排 | **orchestration** | `harness-one/orchestration` |
| — | CLI 脚手架 | **cli** | `npx harness-one` |

## 模块依赖图

```
                    ┌──────────┐
                    │ _internal│  ← JSON Schema 验证器 + Token 估算器
                    └────┬─────┘
                         │
                    ┌────┴─────┐
                    │   core   │  ← 共享类型 + AgentLoop + HarnessError
                    └────┬─────┘
                         │
    ┌────────┬───────┬───┴───┬────────┬────────┬────────┬────────┐
    │        │       │       │        │        │        │        │
    ▼        ▼       ▼       ▼        ▼        ▼        ▼        ▼
 context  prompt   tools  guardrails observe session  memory   eval   evolve  rag  orchestration
    │                │       │
    ▼                ▼       ▼
 _internal       _internal _internal
```

**依赖规则（严格执行）：**
1. `_internal/` → 无依赖（叶子模块）
2. `core/` → 仅 `_internal/`
3. 所有功能模块 → 仅 `core/` + `_internal/`（类型导入为主）
4. **功能模块之间绝不互相导入**（context、tools、guardrails、prompt 等互不依赖）
5. `cli/` → 仅 Node.js 内置模块（fs、path、readline）

## 设计原则

| 原则 | 实现方式 |
|------|---------|
| **工厂函数优先** | 10 个模块中 9 个使用 `createXxx()` 工厂函数，仅 AgentLoop 使用 class（含 `dispose()` 方法） |
| **零运行时依赖** | JSON Schema 验证器和 Token 估算器均为内部实现 |
| **不可变返回值** | 所有工厂返回的对象使用 `Object.freeze()` 冻结 |
| **Fail-Closed 安全默认** | 护栏出错时默认拦截请求，而非放行 |
| **Errors as Data** | 工具失败返回 `ToolResult`，护栏拦截返回 `GuardrailVerdict`，只有编程错误抛出 `HarnessError` |
| **类型即文档** | 所有公共 API 有完整 TypeScript 类型 + JSDoc @example |
| **资源清理** | 有状态模块提供 `dispose()` 方法（AgentLoop、TraceManager、SessionManager、Orchestrator） |
| **渐进式采用** | 每个模块独立可用，无需全部引入 |

## 错误处理策略

| 层级 | 模式 | 示例 |
|------|------|------|
| **编程错误** | 抛出 `HarnessError`（含 `.code` + `.suggestion`） | 缺少必填配置、未知 segment 名 |
| **预期失败** | 返回数据 | `ToolResult.success === false`、`GuardrailVerdict.action === 'block'` |
| **运行时错误** | 通过事件流传递 | `AgentEvent.type === 'error'` |

## 构建与发布

- **构建工具**: tsup（ESM + CJS 双格式输出 + .d.ts）
- **测试工具**: vitest（ESM 原生、TypeScript 优先）
- **类型检查**: tsc --noEmit（strict 模式）
- **包格式**: 单包 `harness-one`，通过 `exports` 字段提供子路径导入
- **CLI**: `package.json` 的 `bin` 字段注册 `harness-one` 命令

## 扩展与集成

harness-one 的扩展遵循统一的**注入模式**：核心模块定义接口（interface），内置默认实现，外部实现在运行时通过工厂函数参数注入。外部依赖不会泄露到接口文件之外。

| 接口 | 模块 | 用途 | 注入方式 | 示例文件 |
|------|------|------|---------|---------|
| `AgentAdapter` | core | 接入 LLM 提供商 | `new AgentLoop({ adapter })` | `examples/adapters/` |
| `LLMConfig` | core | 自定义 temperature/topP/maxTokens | `ChatParams.config` | — |
| `TraceExporter` | observe | 对接外部 APM | `createTraceManager({ exporters })` | `examples/observe/` |
| `MemoryStore` + `searchByVector()` | memory | 自定义存储/向量搜索 | `createRelay({ store })` | `examples/memory/` |
| `PromptBackend` | prompt | 远程模板源 | `createAsyncPromptRegistry(backend)` | `examples/prompt/` |
| `SchemaValidator` | tools | 替换参数校验器 | `createRegistry({ validator })` | `examples/tools/` |
| `Scorer` + `scoreBatch()` | eval | 自定义评分/批量评分 | `createEvalRunner({ scorers })` | `examples/eval/` |

完整的集成示例和使用说明见 [`examples/README.md`](../../examples/README.md)。

## 文档索引

| 文档 | 内容 |
|------|------|
| [00-overview.md](./00-overview.md) | 本文——架构总览 |
| [01-core.md](./01-core.md) | Agent Loop、共享类型、错误层级 |
| [02-prompt.md](./02-prompt.md) | Prompt 工程：Builder、Registry、SkillEngine、渐进披露 |
| [03-context.md](./03-context.md) | 上下文工程：Token 预算、打包、压缩、缓存稳定性 |
| [04-tools.md](./04-tools.md) | 工具系统：定义、注册、验证、执行 |
| [05-guardrails.md](./05-guardrails.md) | 安全护栏：Pipeline、自愈重试、4 个内置护栏 |
| [06-observe.md](./06-observe.md) | 可观测性：Trace/Span、成本追踪、导出器 |
| [07-session.md](./07-session.md) | 会话管理：TTL、LRU、锁定、GC |
| [08-memory.md](./08-memory.md) | 记忆与持久化：MemoryStore、文件系统、跨上下文接力 |
| [09-eval.md](./09-eval.md) | 评估验证：Runner、Scorer、Generator-Evaluator、数据飞轮 |
| [10-evolve.md](./10-evolve.md) | 持续演进：组件注册、漂移检测、架构检查、品味编码 |
| [11-cli.md](./11-cli.md) | CLI 工具：init 脚手架 + audit 审计 |
| [12-orchestration-multi-agent.md](./12-orchestration-multi-agent.md) | 多 Agent 编排：Agent Pool、Handoff Protocol、Context Boundary |
