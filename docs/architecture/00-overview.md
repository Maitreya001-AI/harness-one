# harness-one 架构总览

> **Agent = Model + Harness.** harness-one 提供 Harness 层的通用基础设施。

> `createSecurePreset` 是一套有偏好的参考装配：默认启用 fail-closed
> guardrail pipeline、redaction、tool capability 限制、quota、`sealProviders()`。
> 如果这些默认值不符合你的部署要求，直接用 `createHarness` 或更底层原语组合。
>
> ```ts
> import { createSecurePreset } from '@harness-one/preset';
> const harness = createSecurePreset({ provider: 'anthropic', client, model: 'claude-sonnet-4-20250514' });
> ```
>
> 当前版本仍为 pre-release（`0.x` — 任何 minor bump 都可能 break），
> 所有 break change 直接落 `main`，git log 是真正的发布记录——详见 `MIGRATION.md`。

## 定位

harness-one 是一个 TypeScript 工具库，为 AI Agent 产品提供 Harness Engineering 的通用原语。覆盖参考架构的 9 个层次，以核心包 `harness-one` 中的 12 个子系统 + 7 个独立适配器包 + 1 个 preset 包 + 1 个 CLI + 1 个 devkit 的形式交付。包含多 Agent 编排基础设施（Agent Pool、Handoff Protocol、Context Boundary）和 RAG 流水线，覆盖单 Agent 与多 Agent 协作场景。

**不是框架**——不强制 pipeline 流程，不绑定 LLM 提供商，不管理部署。用户自由组合所需模块。

## 核心数据

> 这些数字反映截稿时的 main 分支状态；git 随时变。若看文档时发现落差，
> 以 `find packages -name '*.test.ts' \| wc -l` + `pnpm -r test` 为准。

| 指标 | 值 |
|------|---|
| 源码文件（全仓库 src，不含 `__tests__` / `tests/` / `.d.ts`） | 277 个 .ts 文件（其中 core 包 164） |
| 测试文件（`*.test.ts`） | 218 个（其中 core 包 176，覆盖单测 + 集成 + 契约 + 混沌 + PBT + fuzz + 类型级） |
| 测试用例（core 包通过数） | 3,727+ 通过（workspace 全量更多；运行 `pnpm -r test` 查看） |
| 源码行数（全仓库 src，不含测试） | ~41,000 行（其中 core 包 ~29k） |
| 运行时依赖（core 包） | 0 |
| 模块数 | 12 核心子系统 + 7 适配器包 + preset + cli + devkit |
| 包结构 | pnpm monorepo，11 个 `packages/*` 工作区 |
| 构建目标 | Node.js >= 18（20 LTS 推荐），ESM + CJS |
| CI 门禁 | 15 个 workflow（`.github/workflows/`）—— lint/typecheck、coverage、api-extractor 快照、link-check、audit、gitleaks、Scorecard、mutation、perf、fuzz、cassette-drift、migrations、reproducible pack、Sigstore 发布、SBOM |

## 包清单

| 包 | 作用 |
|---|---|
| `harness-one` | 核心库，通过 `harness-one/<submodule>` 子路径或根入口使用 |
| `@harness-one/preset` | 预设装配，提供 `createHarness()` / `createSecurePreset()` 一站式装配 |
| `@harness-one/anthropic` | Anthropic 适配器 |
| `@harness-one/openai` | OpenAI 兼容适配器（同时覆盖 OpenAI/Groq/Together 等） |
| `@harness-one/ajv` | Ajv 驱动的 JSON Schema 校验器 |
| `@harness-one/redis` | Redis 后端的 MemoryStore |
| `@harness-one/langfuse` | Langfuse exporter + CostTracker |
| `@harness-one/opentelemetry` | OpenTelemetry exporter |
| `@harness-one/tiktoken` | tiktoken 驱动的精确 tokenizer |
| `@harness-one/cli` | `npx harness-one init/audit` 脚手架与审计工具 |
| `@harness-one/devkit` | 开发时工具——eval runner、evolve checker、component registry、drift detection |

## 导入路径

用户从**三种位置**获取同一套 API。根桶只导出最常用的 18 个值符号（UJ-1..UJ-5 主路径；原 ADR 排布为 19 个槽位，其中 slot 11 `createSecurePreset` 因三角循环风险被下放到 `@harness-one/preset`），其余工厂必须走子路径或兄弟包——这让 tree-shaking 友好，也让根桶的 API 契约保持稳定。

```ts
// 1) 根入口（18 精选值 + 未设上限的 type-only 重导出）——
//    createAgentLoop / AgentLoop / createResilientLoop /
//    createMiddlewareChain / HarnessError / HarnessErrorCode /
//    MaxIterationsError / AbortedError / ToolValidationError /
//    TokenBudgetExceededError / defineTool / createRegistry /
//    createPipeline / createTraceManager / createLogger /
//    createCostTracker / createSessionManager / disposeAll
import { createAgentLoop, HarnessErrorCode } from 'harness-one';

// 2) 子路径（tree-shake 更友好；非根桶内的其余工厂从这里拿）
import { createFsMemoryStore } from 'harness-one/memory';
import { toSSEStream } from 'harness-one/advanced';
import { createFailureTaxonomy } from 'harness-one/observe';

// 3) 兄弟包（preset / cli / devkit）——工具 surface 从 @harness-one/* 拿
import { createSecurePreset } from '@harness-one/preset';
import { createEvalRunner } from '@harness-one/devkit';
```

**重要**：`HarnessErrorCode` 是字符串枚举，必须**值导入**（`import { HarnessErrorCode }`）。`import type` 会静默丢失运行时 `Object.values()` 记录；自定义 lint 规则 `harness-one/no-type-only-harness-error-code` 会在 lint 时拦截。

## 9 层参考架构映射

| 层 | 参考架构 | harness-one 模块 | 子路径 |
|----|---------|-----------------|--------|
| ① | Agent Loop | **core** | `harness-one/core` |
| ② | 上下文工程 | **context** | `harness-one/context` |
| — | Prompt 工程 | **prompt** | `harness-one/prompt` |
| ③ | 工具系统 | **tools** | `harness-one/tools` |
| ④ | 安全与护栏 | **guardrails** | `harness-one/guardrails` |
| ⑤ | 记忆与持久化 | **memory** | `harness-one/memory` |
| ⑥ | 评估与验证 | **devkit/eval** | `@harness-one/devkit` |
| ⑦ | 可观测性 | **observe** | `harness-one/observe`（含 `MetricsPort`、`HarnessLifecycle`） |
| ⑧ | 持续演进 | **devkit/evolve** | `@harness-one/devkit` |
| ⑨ | 熵回收 | **devkit/evolve**（合并） | `@harness-one/devkit` |
| — | 会话管理 | **session** | `harness-one/session` |
| ⑩ | 多 Agent 编排 | **orchestration** | `harness-one/orchestration` |
| — | RAG 流水线 | **rag** | `harness-one/rag` |
| — | CLI 脚手架 | **cli** | `npx harness-one` |

## 模块依赖图

```
                    ┌──────────┐
                    │   infra  │  ← L1：JSON Schema 验证器 + Token 估算器 + ids / redact / backoff
                    └────┬─────┘    + 错误原语（errors-base、brands、disposable）
                         │
                    ┌────┴─────┐
                    │   core   │  ← L2：共享类型 + AgentLoop + HarnessError + 两个跨切 port
                    └────┬─────┘    （MetricsPort、InstrumentationPort）+ pricing
                         │
    ┌────────┬───────┬───┴───┬────────┬────────┬────────┬────────┬──────┐
    │        │       │       │        │        │        │        │      │
    ▼        ▼       ▼       ▼        ▼        ▼        ▼        ▼      ▼
 context  prompt   tools  guardrails observe session  memory  rag  orchestration  evolve-check
    └──────────────────────────┬──────────────────────────────────────────┘
                               ▼
                 以上全是 L3，互相之间绝不导入
```

**依赖规则（严格执行 + ESLint 保障）：**
1. `infra/` → 无依赖（叶子模块；源码目录名即 `packages/core/src/infra/`）
2. `core/` → 仅 `infra/`
3. 所有 L3 功能模块 → 仅 `core/` + `infra/`
4. **L3 功能模块之间绝不互相导入（runtime 或 type-only）**——ESLint `no-restricted-imports` 锁这条边
5. L4 适配器包（anthropic/openai/ajv/redis/langfuse/opentelemetry/tiktoken）→ 只能走 `harness-one/<subpath>` 公共导出，不得 `harness-one/src/**`
6. L5 preset/cli/devkit → 和 L4 同级规则

> 历史版本的文档把 `infra/` 称作 `_internal/`，源码目录从来没有过 `_internal/`。

## 设计原则

| 原则 | 实现方式 |
|------|---------|
| **工厂函数优先** | 12+ 个模块中绝大多数使用 `createXxx()` 工厂函数。AgentLoop 同时提供 `new AgentLoop()` 类形式与 `createAgentLoop()` 工厂别名，两者均为一等 API |
| **零运行时依赖** | JSON Schema 验证器、Token 估算器、LRU 缓存均为内部实现（`infra/`） |
| **不可变返回值** | 所有工厂返回的对象使用 `Object.freeze()` 或 `structuredClone` 冻结；metadata 深拷贝防止外部嵌套修改 |
| **Fail-Closed 安全默认** | 护栏出错时默认拦截请求，而非放行（fail-open 模式下 verdict.reason 区分真正 allow 与错误降级）；所有外部可达 ID 使用 `prefixedSecureId`（crypto-backed）；日志输出通过结构化 Logger 路由（保证 redaction） |
| **Circuit Breaker** | AdapterCaller 可选 `circuitBreaker` 配置（`infra/circuit-breaker.ts`），在 LLM 持续失败时快速失败防止级联故障 |
| **Errors as Data** | 工具失败返回 `ToolResult`，护栏拦截返回 `GuardrailVerdict`，只有编程错误抛出 `HarnessError` |
| **契约即实现** | "声明但未调用"的钩子（TraceExporter.initialize/isHealthy/shouldExport）已补齐实现；公开 `*Capabilities` 字段让后端显式声明所支持的契约级别 |
| **边界必校验** | 任何跨磁盘/网络/用户输入边界的反序列化都走 schema 校验（`validateMemoryEntry` 等），不出现 `JSON.parse(...) as T` 强转。Orchestrator SharedContext 键通过 NFKC+casefold 规范化防止 Unicode 变体绕过 |
| **类型即文档** | 所有公共 API 有完整 TypeScript 类型 + JSDoc @example |
| **资源清理** | 有状态模块提供 `dispose()` 方法（AgentLoop、TraceManager、SessionManager、Orchestrator）；`flush()`/`dispose()` 等待所有 in-flight 异步操作 |
| **生产安全默认** | 无 budget / 默认 session / 无效 Langfuse client 等"会被忽视的问题"通过构造时警告或抛错暴露。所有配置验证错误使用 HarnessError（circuit-breaker、execution-strategies 等），RAG 管道默认 100K 块上限防止 OOM |
| **渐进式采用** | 每个模块独立可用，无需全部引入 |

## 错误处理策略

| 层级 | 模式 | 示例 |
|------|------|------|
| **编程错误** | 抛出 `HarnessError`（含 `.code` + `.suggestion`） | 缺少必填配置、未知 segment 名 |
| **预期失败** | 返回数据 | `ToolResult.success === false`、`GuardrailVerdict.action === 'block'` |
| **运行时错误** | 通过事件流传递 | `AgentEvent.type === 'error'` |

## 构建与发布

- **构建工具**: tsup（ESM + CJS 双格式输出 + .d.ts）
- **测试工具**: vitest（ESM 原生、TypeScript 优先）；4,486+ 用例
- **类型检查**: tsc --noEmit（strict 模式）
- **包格式**: 单核心包 `harness-one`，通过 `exports` 字段提供 15 个子路径（`core` / `advanced` / `prompt` / `context` / `tools` / `guardrails` / `observe` / `session` / `memory` / `evolve-check` / `rag` / `orchestration` / `redact` / `infra` / `testing`）
- **兄弟包**: 10 个独立 npm 包（7 adapter + preset + cli + devkit），全部版本 `0.1.0`，共用 `@changesets/cli` 管理发布
- **CLI**: `@harness-one/cli` 包的 `package.json` `bin` 字段注册 `harness-one` 命令（`npx harness-one`）

## 扩展与集成

harness-one 的扩展遵循统一的**注入模式**：核心模块定义接口（interface），内置默认实现，外部实现在运行时通过工厂函数参数注入。外部依赖不会泄露到接口文件之外。

| 接口 | 模块 | 用途 | 注入方式 | 示例文件 |
|------|------|------|---------|---------|
| `AgentAdapter` | core | 接入 LLM 提供商 | `createAgentLoop({ adapter })` | `examples/adapters/` |
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
- `harness-one/rag` 公开 `runRetrieverConformance` / `runEmbeddingModelConformance` / `runChunkingStrategyConformance`——新 RAG 适配器后端应运行对应套件；规范文档见 [`retriever-spec.md`](../retriever-spec.md) 与 [`embedding-spec.md`](../embedding-spec.md)。
- `docs/provider-spec.md` 是 `AgentAdapter` 的权威规范：必选/可选字段、LLMConfig/responseFormat 处理、TokenUsage 规则、name 约定、错误分类映射、PR 合规清单。新 provider 作者直接按此实现。

## 测试目录布局

`packages/core/` 下除传统的 `src/**/__tests__/*.test.ts` 单测外，还有 6 个专用顶层测试目录：

| 目录 | 内容 | 归属 Track |
|------|------|-----------|
| `packages/core/tests/integration/` | 跨 L3 子系统的集成 scenario（TTL × fs memory × relay、guardrail fail-closed 不变量、parallel-tool 故障隔离、adapter retry + 断路器、fake-timers 下的 session TTL） | Track D（P0） |
| `packages/core/tests/chaos/` | 基于 `createChaosAdapter` 的 seeded 故障注入场景（H1 限流 + fallback、H2 流中断、H3 巨参数、H4 adapter hang、H5 非法 JSON 工具参数） | Track H（P1） |
| `packages/core/tests/perf/` | `tinybench` 微基准 + baseline（I1 AgentLoop、I2 trace span heap、I3 fs-store、I4 StreamAggregator 10 MB、I5 guardrail 10×）；与 `.github/workflows/perf.yml` 联动做 p50/p99 漂移门 | Track I（P1） |
| `packages/core/tests/fuzz/` | `fast-check` 驱动的 parser 模糊测试 + corpus（tool-args / guardrail input / SSE / prompt template）；nightly workflow `fuzz.yml` 跑 ~10k 次/目标 | Track O（P2） |
| `packages/core/tests/type-level/` | `expect-type` + 独立 `tsconfig.json`；CI 跑 `typecheck:type-level` 验证 `AgentEvent` 穷举、branded ID 不可互换、`MetricsPort` 跨 subpath 同一性、`HarnessConfig` discriminated narrow、public-API shape lockfile | Track N（P2） |
| `packages/core/tests/security/` | STRIDE 威胁模型驱动的安全测试（与 `docs/security/*.md` 的 threat model 文档交叉引用） | Track O / P1-M |

PBT（property-based）测试混在 `src/**/__tests__/*.property.test.ts`（J1-J8），不单独拆目录；规则和 fuzz 类似但断言的是不变量而非 crash。

## 文档索引

### 架构主线（01-17）

| 文档 | 内容 |
|------|------|
| [00-overview.md](./00-overview.md) | 本文——架构总览 |
| [01-core.md](./01-core.md) | Agent Loop、共享类型、错误层级（Wave-by-wave 变更见根目录 [`MIGRATION.md`](../../MIGRATION.md) 与 `git log`） |
| [02-prompt.md](./02-prompt.md) | Prompt 工程：Builder、Registry、SkillRegistry、渐进披露 |
| [03-context.md](./03-context.md) | 上下文工程：Token 预算、打包、压缩、缓存稳定性 |
| [04-tools.md](./04-tools.md) | 工具系统：定义、注册、验证、执行 |
| [05-guardrails.md](./05-guardrails.md) | 安全护栏：Pipeline、Guardrail Retry、5 个内置护栏（注入 / 内容 / 速率 / Schema / PII） |
| [06-observe.md](./06-observe.md) | 可观测性：Trace/Span、成本追踪、导出器 |
| [07-session.md](./07-session.md) | 会话管理：TTL、LRU、锁定、GC |
| [08-memory.md](./08-memory.md) | 记忆与持久化：MemoryStore、文件系统、跨上下文接力 |
| [09-eval.md](./09-eval.md) | 评估验证：Runner、Scorer、Generator-Evaluator、数据飞轮 |
| [10-evolve.md](./10-evolve.md) | 持续演进：组件注册、漂移检测、架构检查、品味编码 |
| [11-cli.md](./11-cli.md) | CLI 工具：init 脚手架 + audit 审计 |
| [12-orchestration-multi-agent.md](./12-orchestration-multi-agent.md) | 多 Agent 编排：Agent Pool、Handoff Protocol、Context Boundary |
| [13-rag.md](./13-rag.md) | RAG 流水线：文档加载、分块策略、嵌入、检索、token 估算 |
| [14-advanced.md](./14-advanced.md) | Advanced 扩展点桶：middleware、StreamAggregator、SSE、FallbackAdapter、resilient loop（test utils 在 `harness-one/testing`） |
| [15-redact.md](./15-redact.md) | 秘密脱敏：默认 pattern、结构保留替换、cycle/depth/原型污染三重保险 |
| [16-evolve-check.md](./16-evolve-check.md) | 架构规则检查：循环依赖 + 层级边界 + 自定义规则 runtime/CI 共享 |
| [17-testing.md](./17-testing.md) | Testing 子路径：mock `AgentAdapter` 工厂、cassette/contract 层、整合测试、chaos、perf、PBT、fuzz、类型级测试 |

### 架构决策记录（[`docs/adr/`](../adr/)）

ADR 采用 MADR 4.0 格式。每一条记录一个非显然的设计决定 + 被拒方案 + 承担的后果。

| ADR | 决定 |
|-----|------|
| [0001](../adr/0001-no-graph-dsl.md) | 不做 graph DSL，用显式 loop + factory |
| [0002](../adr/0002-l3-subsystem-isolation.md) | L3 子系统之间禁止相互 import（runtime 和 type-only 都禁） |
| [0003](../adr/0003-factory-functions-not-classes.md) | 工厂函数优先，`new` 仅作 AgentLoop 等历史别名 |
| [0004](../adr/0004-zero-runtime-deps-in-core.md) | `harness-one` core 零运行时依赖 |
| [0005](../adr/0005-trace-cost-token-unified.md) | trace / cost / token 统一用同一 `traceId` |
| [0006](../adr/0006-fail-closed-guardrail-default.md) | guardrail 出错默认 fail-closed |
| [0007](../adr/0007-trusted-system-message-brand.md) | `SystemMessage._trust` 用 process-local symbol 标记 |
| [0008](../adr/0008-adapter-conformance-not-mocks.md) | adapter 用共享 conformance suite 测，不是 mock |
| [0009](../adr/0009-streaming-hard-limits.md) | stream size 超限是硬错，不是 warn |
| [0010](../adr/0010-observe-port-vs-implementation.md) | `MetricsPort` 在 core 定义，实现留给兄弟包 |

新增决定的起草模板：[`0000-adr-template.md`](../adr/0000-adr-template.md)。

### 安全与威胁模型（[`docs/security/`](../security/)）

每个 L3 子系统单独一份 STRIDE 威胁模型 + 对应测试在 `packages/core/tests/security/`。

| 子系统 | 文档 |
|--------|------|
| core（Agent Loop） | [core.md](../security/core.md) |
| prompt | [prompt.md](../security/prompt.md) |
| context | [context.md](../security/context.md) |
| tools | [tools.md](../security/tools.md) |
| guardrails | [guardrails.md](../security/guardrails.md) |
| observe | [observe.md](../security/observe.md) |
| session | [session.md](../security/session.md) |
| memory | [memory.md](../security/memory.md) |
| rag | [rag.md](../security/rag.md) |
| redact | [redact.md](../security/redact.md) + [redact-findings.md](../security/redact-findings.md)（审计发现清单） |
| TypeDoc 审计 | [typedoc-findings.md](../security/typedoc-findings.md) |
| OpenSSF Best Practices | [ossf-best-practices.md](../security/ossf-best-practices.md)（Passing 级自评，项目 ID 待 owner 提交申请） |

### 测试蓝图（[`docs/testing-plan/`](../testing-plan/) + [`docs/testing-plan.md`](../testing-plan.md)）

按 Track 拆分的可执行落地 prompt；每个 CI workflow 都对应一个 Track。P0/P1 已随今日 commit 落地，P2 部分在路上。

| Track | 主题 | 文档 |
|-------|------|------|
| A | 社区治理 | [P0-A-community.md](../testing-plan/P0-A-community.md) |
| B | CI 工程基础 | [P0-B-ci-infra.md](../testing-plan/P0-B-ci-infra.md) |
| C | 契约 suite + Cassette | [P0-C-contract-cassette.md](../testing-plan/P0-C-contract-cassette.md) |
| D | 跨子系统集成测试 | [P0-D-integration.md](../testing-plan/P0-D-integration.md) |
| E | Examples CI | [P0-E-examples-ci.md](../testing-plan/P0-E-examples-ci.md) |
| F | ADR | [P0-F-adr.md](../testing-plan/P0-F-adr.md) |
| G | Dogfood | [P0-G-dogfood.md](../testing-plan/P0-G-dogfood.md) |
| H | Chaos | [P1-H-chaos.md](../testing-plan/P1-H-chaos.md) |
| I | Perf baseline | [P1-I-perf.md](../testing-plan/P1-I-perf.md) |
| J | PBT | [P1-J-pbt.md](../testing-plan/P1-J-pbt.md) |
| K | Mutation testing | [P1-K-mutation.md](../testing-plan/P1-K-mutation.md) |
| L | DX（size-limit / tree-shake / TSDoc lint / error-lint） | [P1-L-dx.md](../testing-plan/P1-L-dx.md) |
| M | Security docs | [P1-M-security-docs.md](../testing-plan/P1-M-security-docs.md) |
| N | 类型级测试 | [P2-N-type-level.md](../testing-plan/P2-N-type-level.md) |
| O | Fuzz + 威胁模型 | [P2-O-fuzz-threat.md](../testing-plan/P2-O-fuzz-threat.md) |
| P | Release 工程 | [P2-P-release.md](../testing-plan/P2-P-release.md) |

### 其它

| 文档 | 内容 |
|------|------|
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | 一页纸分层合同（L1..L5 依赖方向） |
| [`../provider-spec.md`](../provider-spec.md) | `AgentAdapter` 权威规范（新 provider 作者必读） |
| [`../retriever-spec.md`](../retriever-spec.md) / [`../embedding-spec.md`](../embedding-spec.md) / [`../chunking-spec.md`](../chunking-spec.md) | RAG 三套 conformance 规范 |
| [`../release.md`](../release.md) | 发布 runbook |
| [`../i18n-strategy.md`](../i18n-strategy.md) | 文档语言策略（canonical = EN，README 中英双 landing） |
| [`../../MIGRATION.md`](../../MIGRATION.md) | pre-release 破坏性变更账本 |
