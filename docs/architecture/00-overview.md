# harness-one 架构总览

> **Agent = Model + Harness.** harness-one 提供 Harness 层的通用基础设施。

> **Production entry (Wave-5A, 1.0-rc)**: 生产部署请直接用 `createSecurePreset` 而非 `createHarness`。
> 它 fail-closed 默认启用 guardrail pipeline、redaction（logger + trace + Langfuse）、tool
> capability 限制（`['readonly']`）、tool registry 配额（20/turn, 100/session, 30s timeout）、
> `sealProviders()`。`createHarness` 仍保留作为逃生门。
>
> ```ts
> import { createSecurePreset } from '@harness-one/preset';
> const harness = createSecurePreset({ provider: 'anthropic', client, model: 'claude-sonnet-4-20250514' });
> ```

## 定位

harness-one 是一个 TypeScript 工具库，为 AI Agent 产品提供 Harness Engineering 的通用原语。覆盖参考架构的 9 个层次，以 12+ 个独立模块 + 1 个 CLI 工具的形式交付。自 2026-04 起，新增多 Agent 编排基础设施（Agent Pool、Handoff Protocol、Context Boundary）和 RAG 流水线，将单 Agent 架构扩展至多 Agent 协作与检索增强场景。

**不是框架**——不强制 pipeline 流程，不绑定 LLM 提供商，不管理部署。用户自由组合所需模块。

## 核心数据

| 指标 | 值 |
|------|---|
| 源码文件 | ~100 个 .ts 文件 |
| 测试文件 | ~80 个 .test.ts 文件 |
| 测试用例 | 3,200+ |
| 源码行数 | ~18,000 行 |
| 运行时依赖 | 0 |
| 模块数 | 12+ 核心模块 + 7 集成包 + 1 preset 包 |
| 包结构 | pnpm monorepo with 10 packages |
| 构建目标 | Node.js >= 18, ESM + CJS |

## 包清单

| 包 | 作用 |
|---|---|
| `harness-one` | 核心库，通过 `harness-one/<submodule>` 子路径或新的根入口使用 |
| `@harness-one/preset` | 批处理式预设（原名 `harness-one-full`，于 0.2.0 改名），提供 `createHarness()` 一站式装配 |
| `@harness-one/anthropic` | Anthropic 适配器 |
| `@harness-one/openai` | OpenAI 兼容适配器（同时覆盖 OpenAI/Groq/Together 等） |
| `@harness-one/ajv` | Ajv 驱动的 JSON Schema 校验器 |
| `@harness-one/redis` | Redis 后端的 MemoryStore |
| `@harness-one/langfuse` | Langfuse exporter + CostTracker |
| `@harness-one/opentelemetry` | OpenTelemetry exporter |
| `@harness-one/tiktoken` | tiktoken 驱动的精确 tokenizer |

## 导入路径（1.0-rc / Wave-5C）

用户从**三种位置**获取同一套 API。Wave-5C 将根桶从 ~40 收紧到 **19 个精选值导出**（UJ-1..UJ-5 主路径），其余工厂必须走子路径或兄弟包。

```ts
// 1) 根入口（19 精选值）—— createAgentLoop / AgentLoop / createResilientLoop /
//    createMiddlewareChain / HarnessError / HarnessErrorCode / MaxIterationsError /
//    AbortedError / GuardrailBlockedError / ToolValidationError /
//    TokenBudgetExceededError / defineTool / createRegistry / createPipeline /
//    createTraceManager / createLogger / createCostTracker /
//    createSessionManager / disposeAll
import { createAgentLoop, HarnessErrorCode } from 'harness-one';

// 2) 子路径（tree-shake 更友好；非根桶内的其余工厂从这里拿）
import { createEventBus } from 'harness-one/core';
import { toSSEStream } from 'harness-one/core';
import { createFsMemoryStore } from 'harness-one/memory';

// 3) 兄弟包（preset / cli / devkit）—— 工具性surface从 @harness-one/* 拿
import { createSecurePreset } from '@harness-one/preset';   // Wave-5C 不再经由 harness-one 根桶
import { createEvalRunner } from '@harness-one/devkit';      // 取代旧的 harness-one/eval
```

**重要（Wave-5C）**：`HarnessErrorCode` 是字符串枚举，必须**值导入**（`import { HarnessErrorCode }`）。`import type` 会静默丢失运行时 `Object.values()` 记录；自定义 lint 规则 `harness-one/no-type-only-harness-error-code` 会在 lint 时拦截。

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
| — | RAG 流水线 | **rag** | `harness-one/rag` |
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
    │                │       │          │                │
    ▼                ▼       ▼          ▼                ▼
 _internal       _internal _internal _internal       fs-io (extracted)
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
| **工厂函数优先** | 12+ 个模块中绝大多数使用 `createXxx()` 工厂函数。AgentLoop 同时提供 `new AgentLoop()` 类形式与 `createAgentLoop()` 工厂别名（0.2.0 统一风格） |
| **零运行时依赖** | JSON Schema 验证器、Token 估算器、LRU 缓存均为内部实现（`_internal/`） |
| **不可变返回值** | 所有工厂返回的对象使用 `Object.freeze()` 或 `structuredClone` 冻结；metadata 从 0.2.0 起深拷贝防止外部嵌套修改 |
| **Fail-Closed 安全默认** | 护栏出错时默认拦截请求，而非放行 |
| **Errors as Data** | 工具失败返回 `ToolResult`，护栏拦截返回 `GuardrailVerdict`，只有编程错误抛出 `HarnessError` |
| **契约即实现** | 0.2.0 对"声明但未调用"的钩子（TraceExporter.initialize/isHealthy/shouldExport）补齐实现；公开 `*Capabilities` 字段让后端显式声明所支持的契约级别 |
| **边界必校验** | 任何跨磁盘/网络/用户输入边界的反序列化都走 schema 校验（`validateMemoryEntry` 等），不再出现 `JSON.parse(...) as T` 强转 |
| **类型即文档** | 所有公共 API 有完整 TypeScript 类型 + JSDoc @example |
| **资源清理** | 有状态模块提供 `dispose()` 方法（AgentLoop、TraceManager、SessionManager、Orchestrator）；`flush()`/`dispose()` 等待所有 in-flight 异步操作 |
| **生产安全默认** | 0.2.0 开始：无 budget / 默认 session / 无效 Langfuse client 等"会被忽视的问题"通过构造时警告或抛错暴露 |
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
| `EmbeddingModel` | rag | 接入向量嵌入服务 | `createRAGPipeline({ embedding })` | — |
| `Retriever` | rag | 接入向量数据库 | `createRAGPipeline({ retriever })` | — |
| `MessageTransport` | orchestration | 自定义跨 Agent 消息通道 | `createHandoff(transport)` | — |
| `ToolMiddleware` | tools | 洋葱式包装 tool.execute（retry / auth / circuit-breaker） | `ToolDefinition.middleware` | — |

完整的集成示例和使用说明见 [`examples/README.md`](../../examples/README.md)。

## 合规测试与规范文档

- `harness-one/memory` 公开 `runMemoryStoreConformance(runner, factory)`——新 MemoryStore 后端应运行此合规套件以证明对外契约（内存实现也 dogfood 该套件）。
- `docs/provider-spec.md` 是 `AgentAdapter` 的权威规范：必选/可选字段、LLMConfig/responseFormat 处理、TokenUsage 规则、name 约定、错误分类映射、PR 合规清单。新 provider 作者直接按此实现。

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
| [13-rag.md](./13-rag.md) | RAG 流水线：文档加载、分块策略、嵌入、检索、token 估算 |
