# harness-one

[![codecov](https://codecov.io/gh/Maitreya001-AI/harness-one/graph/badge.svg)](https://codecov.io/gh/Maitreya001-AI/harness-one)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/Maitreya001-AI/harness-one/badge)](https://securityscorecards.dev/viewer/?uri=github.com/Maitreya001-AI/harness-one)
[![OpenSSF Best Practices](https://bestpractices.coreinfrastructure.org/projects/12635/badge)](https://bestpractices.coreinfrastructure.org/projects/12635)

> AI Agent **Harness 层**（非模型层）的通用基础设施。把最难的 30% 工程活一次做对、做完。

**语言版本**: [English → `README.md`](./README.md) · **中文**（本文件）

> 项目 canonical 文档语言是英文（见 [`docs/i18n-strategy.md`](./docs/i18n-strategy.md)）。
> 本文件是给中文读者的入口镜像，**不是**英文 README 的完整翻译——
> Feature Maturity、Troubleshooting、所有模块的详细 ts 示例等在英文版。
> 阅读完整 API 请优先看 [`README.md`](./README.md)。

## 什么是 Harness Engineering？

一个 AI Agent 由两部分组成：**模型** 和 **Harness**。模型提供智能；Harness 提供其余所有环节——上下文管理、工具路由、安全护栏、可观测性、记忆、评估、会话编排。

Harness Engineering 是围绕 LLM 搭建生产级基础设施的工程学科。它与框架无关、与模型无关，生命周期显著长于任何一代具体模型。

## 为什么选 harness-one？

- **框架无关**——通过简单的 `AgentAdapter` 接口适配任何 LLM 提供商（OpenAI、Anthropic、本地模型）
- **可组合原语**——12+ 模块按需使用，无"全有或全无"的框架锁定
- **零运行时依赖**——纯 TypeScript，生产依赖链上无任何第三方代码可供审计
- **完整覆盖**——在一个内聚包内覆盖 Harness 参考架构的全部 9 层，外加 RAG、多 Agent 编排等

## 快速开始

> **最短路径**：先看 [`examples/quickstart.ts`](./examples/quickstart.ts)
> —— 20 行、一个 SDK、第一条流式回复。下面是同一模式的展开版。

### `createSecurePreset` vs `createHarness` vs `createAgentLoop`

三个入口，区别在于帮你预装多少 wiring：

| 入口 | 包 | 提供内容 | 适合场景 |
|---|---|---|---|
| **`createSecurePreset`** | `@harness-one/preset` | `createHarness` 的全部能力，外加 fail-closed guardrail pipeline、默认 redaction、`['readonly']` tool capability allow-list、sealed provider registry | 你想要一套有偏好的安全默认装配，尽快落地 |
| **`createHarness`** | `@harness-one/preset` | adapter、logger、traceManager、sessionManager、memory、cost tracker、lifecycle 等全部子系统预连好 | 你想要整套装配，但安全姿态由自己决定 |
| **`createAgentLoop`** | `harness-one` | 只有 loop 和你显式传入的端口 | 你要自己组合各个原语 |

`createSecurePreset` 不是唯一的生产路径。它适合默认值和你的部署要求一致的情况；不一致就直接降到 `createHarness` 或底层原语。

两条安装路径：

```bash
# 按需安装 —— core 包（子路径可 tree-shake）。
npm install harness-one

# 一站式预设 —— core + 常用集成一起装。
npm install @harness-one/preset @anthropic-ai/sdk
```

### Secure preset

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createSecurePreset } from '@harness-one/preset';

const harness = createSecurePreset({
  provider: 'anthropic',
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: 'claude-sonnet-4-20250514',
  // guardrailLevel 默认是 'standard'
});
```

默认行为包括：

- `logger` / `traceManager` 默认脱敏
- tool registry 默认 `allowedCapabilities: ['readonly']`
- AgentLoop 预接好 input / output / tool-output guardrail hooks
- OpenAI provider registry 构造后 seal
- 自动创建 `HarnessLifecycle` 和 `MetricsPort`
- 构造期统一配置校验，及时拦 typo 和非法值

### 直接使用 `harness-one`

所有公开 API 既从**根入口**（18 个精选值符号）再导出，也保留各子路径导入——按 tree-shake 需求选择。完整 subpath ↔ symbol 对照表见 [`docs/guides/import-paths.md`](./docs/guides/import-paths.md)。

```typescript
// 根入口：原型开发 / 示例代码更便利
import { createAgentLoop, defineTool, createRegistry, createPipeline } from 'harness-one';

// 子路径：生产代码 tree-shake 更精准
import { AgentLoop } from 'harness-one/core';
import { defineTool, createRegistry, toolSuccess } from 'harness-one/tools';
import { createPipeline, createInjectionDetector, runInput } from 'harness-one/guardrails';
```

> **非重入约束**：`AgentLoop.run()` 在同一实例上再次调用时抛
> `HarnessError('INVALID_STATE')`。并发请求请使用多个 `AgentLoop` 实例，
> 或 await 上一次 `run()` 完成后再调用。

### 使用 `@harness-one/preset`

`@harness-one/preset` 提供两条路径：

- `createSecurePreset()`：有偏好的参考装配，带 fail-closed 默认值
- `createHarness()`：同样是一站式 wiring，但不强制安全姿态

完整选项（`AdapterHarnessConfig` vs provider shorthand、optional integrations、graceful shutdown、lifecycle health 等）见 [`packages/preset/README.md`](./packages/preset/README.md)。

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { createHarness } from '@harness-one/preset';

const harness = createHarness({
  provider: 'anthropic',
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: 'claude-sonnet-4-20250514',
  budget: 5.0,  // 生产必填，否则构造时打 warn
});

for await (const event of harness.run(messages, { sessionId: userId })) {
  if (event.type === 'message') console.log(event.message.content);
  if (event.type === 'done') break;
}
await harness.shutdown();
```

## 覆盖的 9 层参考架构

| 层 | 架构名 | harness-one 模块 | 子路径导入 |
|---|---|---|---|
| ① | Agent Loop | core | `harness-one/core` |
| ② | 上下文工程 | context | `harness-one/context` |
| — | Prompt 工程 | prompt | `harness-one/prompt` |
| ③ | 工具系统 | tools | `harness-one/tools` |
| ④ | 安全与护栏 | guardrails | `harness-one/guardrails` |
| ⑤ | 记忆与持久化 | memory | `harness-one/memory` |
| ⑥ | 评估与验证 | devkit/eval | `@harness-one/devkit` |
| ⑦ | 可观测性 | observe | `harness-one/observe` |
| ⑧ | 持续演进 | devkit/evolve | `@harness-one/devkit` |
| ⑨ | 熵回收 | devkit/evolve（合并） | `@harness-one/devkit` |
| — | 会话管理 | session | `harness-one/session` |
| ⑩ | 多 Agent 编排 | orchestration | `harness-one/orchestration` |
| — | RAG 流水线 | rag | `harness-one/rag` |
| — | CLI 脚手架 | cli | `npx harness-one` |

详细架构说明在 [`docs/architecture/`](./docs/architecture/)。

## 核心设计决策

> 项目仍为 pre-release（`0.x` — 任何 minor bump 都可能 break）。已发布版本见
> [npm `@harness-one` org 主页](https://www.npmjs.com/org/harness-one)；完整破坏性变更见
> [`MIGRATION.md`](./MIGRATION.md) 的 Unreleased 段与 `git log`。

### 包边界与 API 收口

- **根桶 18 个值导出**（UJ-1..UJ-5 主路径）。其余工厂走子路径（`harness-one/core`、`harness-one/tools`、`harness-one/observe`、`harness-one/infra` 等）或兄弟包。**`createSecurePreset` 不从根桶导出**（避免三角循环）——直接从 `@harness-one/preset` 导入。
- **`HarnessErrorCode` 封闭枚举 + 模块前缀**：成员如 `CORE_UNKNOWN`、`CORE_MAX_ITERATIONS`、`GUARD_VIOLATION`。`HarnessError.code` 不做 `(string & {})` widening，`switch` 可穷举校验。**必须值导入** `import { HarnessErrorCode }`——`import type` 会静默丢失 `Object.values()`，自定义 lint 规则 `harness-one/no-type-only-harness-error-code` 在 lint 时拦截。
- **`@harness-one/cli` 与 `@harness-one/devkit` 独立包**：CLI 位于 [`@harness-one/cli`](./packages/cli)（`pnpm dlx @harness-one/cli init`）；eval + evolve 开发工具位于 [`@harness-one/devkit`](./packages/devkit)；运行时架构规则保留在 core 的 `harness-one/evolve-check` 子路径。
- **`harness-one/testing` 子路径**：mock `AgentAdapter` 工厂（`createMockAdapter` / `createFailingAdapter` / `createStreamingMockAdapter` / `createErrorStreamingMockAdapter`）独立于 `/advanced`。`/advanced` 只导出生产代码可以直接组合的扩展原语（middleware / resilient-loop / fallback-adapter / SSE / 执行策略 / validators / backoff / output parser / trusted system-message）。详见 [`docs/architecture/17-testing.md`](./docs/architecture/17-testing.md)。

### 可观测性 + 生命周期

```ts
import {
  createNoopMetricsPort,        // counter / gauge / histogram 接口（host 可桥到 OTel）
  createHarnessLifecycle,       // init → ready → draining → shutdown 状态机 + 聚合 health()
} from 'harness-one/observe';

import { createAdmissionController } from 'harness-one/infra';

const admission = createAdmissionController({ maxInflight: 64, defaultTimeoutMs: 5000 });
await admission.withPermit('tenant-123', () => harness.run(messages));
```

- **iteration span 属性富化**：每次迭代 span 携带 `iteration` / `adapter` / `conversationLength` / `streaming` / `toolCount` / `inputTokens` / `outputTokens`。
- **adapter retry 可见**：rate-limit / network 重试作为 `adapter_retry` span 事件记录 `attempt` / `errorCategory` / `error`。
- **tool span 归因**：`toolName` / `toolCallId` 作为**属性**写入 span，trace 后端可按 toolName 聚合失败率。
- **guardrail 判决进 trace**：`harness.run()` 每次守卫检查生成 `guardrail:input` / `guardrail:output` / `guardrail:tool-args` / `guardrail:tool-result` 子 span。
- **CostTracker `strictMode` / `warnUnpricedModels`**：`recordUsage()` 可选严格模式；未注册定价的 model 首次出现时打一次警告。

### 信任边界与多租户

- **`createTrustedSystemMessage` brand**：`SystemMessage._trust` 标记 host-only system message；恢复路径无 brand 的 system 消息降级为 `user`。
- **`@harness-one/redis` 多租户键**：`RedisStoreConfig.tenantId` 必填（默认 `'default'` 一次性 warn）；键格式 `prefix:{tenantId}:id`。
- **memory 字节上限 + 保留键**：1 MiB content / 16 KiB metadata；`_version` / `_trust` 是保留键。
- **`createContextBoundary` segment 边界**：策略前缀必须以 `.` 或 `/` 结尾，否则构造抛 `CORE_INVALID_CONFIG`。
- **`HandoffManager.createSendHandle(from)` sealed 句柄** + payload 64 KiB / depth 16 上限。
- **`additionalProperties: false` 运行时 enforce**。
- **`runRagContext`** 逐 chunk 跑入 input pipeline；任一 chunk 命中污染整个检索集。

### 契约与实现对齐

- **TraceExporter 生命周期钩子** `initialize?()` / `isHealthy?()` / `shouldExport?(trace)` 由 TraceManager 真正调用。第三方 exporter 写的 lazy-init、采样、健康检查都生效。
- **Anthropic tool_use 输入守卫**：LLM 返回非 JSON 对象的工具参数时，替换为空对象并 `console.warn`，不做静默强转。
- **持久化边界 schema 校验**：`memory/fs-io`、`memory/relay`、`@harness-one/redis` 每处反序列化都走 `validateMemoryEntry` / `validateIndex` / `validateRelayState`；坏数据抛 `HarnessError('STORE_CORRUPTION')`。
- **Adapter 默认 logger 统一**：5 个 adapter 默认 logger 走 core 的 `createDefaultLogger()` / `safeWarn`（不直接 `console.warn`）。
- **crypto-backed ID**：`checkpoint` ID 使用 `crypto.randomBytes`；trace 采样使用 `crypto.randomInt`。
- **`unrefTimeout` / `unrefInterval`**：`harness-one/infra` 提供的工具函数，长生命周期 timer 默认不持有事件循环。
- **preset pricing 校验**：拒绝 NaN / Infinity。

### 扩展点契约

- **Tool middleware**：`ToolDefinition.middleware` 支持洋葱式包装，做 retry / auth / circuit-breaker 无需改写 `execute`。
- **MemoryStore 能力声明 + writeBatch**：`capabilities` 字段让后端显式声明原子性、TTL、批量能力；`writeBatch()` 为批量写入保留原子性语义。
- **ConversationStore 能力声明**：`atomicAppend` / `atomicSave` / `atomicDelete` / `distributed` 四个字段。
- **`createAgentLoop` 工厂**：和 `new AgentLoop(...)` 等价但对齐 `createX()` 风格，便于 wrap / decorator。
- **Provider 规范文档**：`docs/provider-spec.md` 是新 adapter 作者的权威参考（required vs optional、cache token、error 分类映射、PR 清单）。
- **MemoryStore 合规测试套件**：`runMemoryStoreConformance(runner, factory)` 让新后端（Postgres / DynamoDB / Vespa）跑同一套契约测试。
- **RAG 合规测试套件**：`runRetrieverConformance` / `runEmbeddingModelConformance` / `runChunkingStrategyConformance` 让新的 Retriever / EmbeddingModel / ChunkingStrategy 实现对齐同一份公开契约；规范文档见 [`docs/retriever-spec.md`](./docs/retriever-spec.md) 和 [`docs/embedding-spec.md`](./docs/embedding-spec.md)。

### 发布管线

- `@changesets/cli`：`pnpm changeset` → `pnpm changeset version` → `pnpm changeset publish`。
- CI 强制 per-package 覆盖率阈值（lines/statements 80%、branches 75%）。
- CI 校验 sourcemap / declaration map 产物，防止静默丢 sourcemap。
- CI 包含 changeset-check job，触碰 `packages/` 的 PR 必须带 changeset。

### 破坏性契约

三处行为契约会响亮失败（不静默降级）：

1. **`HarnessConfig.langfuse`** 必须是带 `.trace()` 方法的对象——`{}` 之类的占位对象构造时抛 `INVALID_CONFIG`。
2. **Memory 持久化读取路径** 遇到 shape 错误的数据抛 `STORE_CORRUPTION`。
3. **`AgentLoop.run()`** 同实例并发调用抛 `INVALID_STATE`。

## 子模块速查

每个模块完整的英文 API 参考在 [`docs/modules.md`](./docs/modules.md)；每个 subpath 持有的具体符号清单在 [`docs/guides/import-paths.md`](./docs/guides/import-paths.md)。下表是中文导览：

- **core** · `harness-one/core` — AgentLoop / createAgentLoop / Message / HarnessError / FallbackAdapter
- **context** · `harness-one/context` — packContext / compress / compactIfNeeded / registerTokenizer
- **prompt** · `harness-one/prompt` — PromptBuilder / Registry / SkillRegistry / DisclosureManager
- **tools** · `harness-one/tools` — defineTool / createRegistry / ToolMiddleware / toolSuccess/toolError
- **guardrails** · `harness-one/guardrails` — createPipeline / injection/pii/contentFilter/rateLimiter/schemaValidator / withGuardrailRetry
- **observe** · `harness-one/observe` — createTraceManager / createCostTracker / createLogger / FailureTaxonomy / CacheMonitor / HarnessLifecycle / MetricsPort
- **session** · `harness-one/session` — createSessionManager / createInMemoryConversationStore / AuthContext
- **memory** · `harness-one/memory` — createInMemoryStore / createFileSystemStore / createRelay / runMemoryStoreConformance / validate\* guards
- **devkit** · `@harness-one/devkit` — createEvalRunner / createBasicRelevanceScorer / runGeneratorEvaluator / extractNewCases / createComponentRegistry / 漂移检测
- **evolve-check** · `harness-one/evolve-check` — 运行时架构规则引擎（循环依赖 + 层级边界 + 自定义规则）
- **orchestration** · `harness-one/orchestration` — createOrchestrator / createAgentPool / createHandoff / createContextBoundary / MessageQueue
- **rag** · `harness-one/rag` — createRAGPipeline / createInMemoryRetriever / runRetrieverConformance / runEmbeddingModelConformance / runChunkingStrategyConformance（覆盖文档加载、分块、嵌入、检索、token 估算、多租户隔离）
- **infra** · `harness-one/infra` — createAdmissionController / unrefTimeout / unrefInterval
- **evolve-check** · `harness-one/evolve-check` — noCircularDepsRule / layerDependencyRule / createArchitectureChecker
- **redact** · `harness-one/redact` — createRedactor / redactValue / sanitizeAttributes / DEFAULT_SECRET_PATTERN
- **testing** · `harness-one/testing` — **仅测试用**，不要从生产代码 import：
  - Mock adapter: `createMockAdapter` / `createFailingAdapter` / `createStreamingMockAdapter` / `createErrorStreamingMockAdapter`
  - Chaos: `createChaosAdapter` / `createSeededRng`（H1-H5 故障注入）
  - Cassette 录制回放: `recordCassette` / `createCassetteAdapter` / `loadCassette` / `computeKey` / `fingerprint`
  - Adapter 契约套件: `createAdapterContractSuite` / `CONTRACT_FIXTURES` / `cassetteFileName` / `contractFixturesHandle`
- **preset** · `@harness-one/preset` — createSecurePreset（有偏好的参考装配，含 lifecycle + metrics 自动装配）/ createHarness / createShutdownHandler / validateHarnessConfig

## 质量门禁与供应链

harness-one 的质量承诺全部写进 `.github/workflows/`，总计 15 个 CI workflow：

| 类别 | Workflow | 触发时机 | 断言 |
|------|---------|----------|------|
| 核心 CI | `ci.yml` | PR + push main | lint / typecheck / 单测 + 集成 + 契约 + 混沌 + 类型级；每个包的覆盖率下限（`packages/core` 80% lines/statements、75% branches） |
| API 稳定性 | `api-check.yml` | PR | `api-extractor` 快照 diff——触公开 API 必须同步提交 `packages/*/etc/*.api.md` |
| 兼容矩阵 | `compat-matrix.yml` | PR | 每个 adapter 对着声明的最低/中/最高 peer-dep 版本都 install 一遍 |
| 文档链接 | `docs-links.yml` | PR + 周定时 | `lychee` 扫所有 Markdown，链接坏了直接红 |
| 安全 | `audit.yml` / `secret-scan.yml` / `scorecard.yml` | PR + 周定时 / push | `pnpm audit --prod` 高危直接红；gitleaks 硬失败；OpenSSF Scorecard 周扫并进 GitHub code scanning |
| 变异测试 | `mutation.yml` | 周定时 + 手动 | Stryker 跑 core 的 validate / guardrail pipeline / agent-loop 三子集 |
| 性能 | `perf.yml` | PR | tinybench 对 5 条关键路径做 p50/p99 漂移门 |
| Fuzz | `fuzz.yml` | nightly + 手动 | fast-check ~10k 次/目标，覆盖 4 个 parser（tool-args / guardrail input / SSE / prompt template） |
| Cassette 漂移 | `cassette-drift.yml` | nightly | 重录 Anthropic + OpenAI 契约 cassette，diff 则开 issue 不自动提交 |
| 迁移 | `migrations.yml` | PR | 跑 `tools/migrations/*/` 每个 fixture 的 pre→fail / post→pass 断言 |
| 发布可复现 | `release-pack.yml` | PR 触包 | `pnpm pack` 在固定 `SOURCE_DATE_EPOCH` 下必须 byte-identical（SLSA provenance 的前置） |
| 发布 | `release.yml` | GitHub Release tag | 构建 → 再验复现 → Sigstore 签 SLSA provenance → npm OIDC trusted publisher 发布（无 `NPM_TOKEN`） |
| SBOM | `sbom.yml` | tag + 手动 | 生成 CycloneDX SBOM + npm audit 快照，作为 Release asset |

社区文件 + 安全材料：

- [`SECURITY.md`](./SECURITY.md)——支持版本、私报流程、7 天 ack / 30 天 fix SLA、safe harbor。
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)——Contributor Covenant v2.1。
- [`.github/CODEOWNERS`](./.github/CODEOWNERS)——按 path 自动请审。
- [`docs/security/`](./docs/security/)——每个 L3 子系统一份 STRIDE 威胁模型 + OpenSSF Best Practices 自评（项目 ID `12635`，passing 级通过）。
- [`docs/adr/`](./docs/adr/)——10 份 MADR 4.0 格式的架构决策记录。

## Showcases

四个可直接跑的差异化 demo。Triage Bot 每天在本仓真实驱动；其余三个在
`examples:smoke` 下确定性运行（无需 API key）。

| Showcase | 文件 | 验证了什么 |
|---|---|---|
| Issue Triage Bot（dogfood） | [`apps/dogfood/`](./apps/dogfood/) | `createSecurePreset` + tools + guardrails 在每个新 issue 上真实跑；报告写入 `dogfood-reports/`。 |
| 带引用的 Codebase Q&A | [`examples/showcases/codebase-qa.ts`](./examples/showcases/codebase-qa.ts) | RAG + 对每个 chunk 跑 fail-closed guardrail + `file:line` 引用。 |
| Autoresearch（Ralph 风格） | [`examples/showcases/autoresearch-loop.ts`](./examples/showcases/autoresearch-loop.ts) | 置信度门控循环 + 主 search 失败 → 指数退避 → fallback。 |
| Evolve-check 审计 | [`examples/showcases/evolve-check-demo.ts`](./examples/showcases/evolve-check-demo.ts) | `ComponentRegistry` + `DriftDetector` + `TasteCodingRegistry` 组合成一次"代码一直对"巡检。 |

## 文档

完整架构文档入口：[`docs/architecture/00-overview.md`](./docs/architecture/00-overview.md)

### API 参考与导览

| 主题 | 文档 |
|---|---|
| 每个 subpath 的公开 API 与代码示例（英文） | [docs/modules.md](./docs/modules.md) |
| Subpath ↔ symbol 速查表（英文） | [docs/guides/import-paths.md](./docs/guides/import-paths.md) |
| 特性成熟度矩阵（Production / Monitoring / Advisory / 等） | [docs/feature-maturity.md](./docs/feature-maturity.md) |
| `@harness-one/preset` 的完整选项与 footguns | [packages/preset/README.md](./packages/preset/README.md) |
| `@harness-one/cli` 命令清单 | [packages/cli/README.md](./packages/cli/README.md) |
| 排查指南（错误码 → 症状 / 修法） | [docs/guides/troubleshooting.md](./docs/guides/troubleshooting.md) |
| Fallback adapter 行为 + 周期性恢复 pattern | [docs/guides/fallback.md](./docs/guides/fallback.md) |

### 架构主线

| 主题 | 文档 |
|---|---|
| 一页纸分层合同 | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| 架构总览 | [00-overview.md](./docs/architecture/00-overview.md) |
| Core（AgentLoop） | [01-core.md](./docs/architecture/01-core.md) |
| Prompt 工程 | [02-prompt.md](./docs/architecture/02-prompt.md) |
| 上下文工程 | [03-context.md](./docs/architecture/03-context.md) |
| 工具系统 | [04-tools.md](./docs/architecture/04-tools.md) |
| 安全护栏 | [05-guardrails.md](./docs/architecture/05-guardrails.md) |
| 可观测性 | [06-observe.md](./docs/architecture/06-observe.md) |
| 会话管理 | [07-session.md](./docs/architecture/07-session.md) |
| 记忆与持久化 | [08-memory.md](./docs/architecture/08-memory.md) |
| 评估与验证 | [09-eval.md](./docs/architecture/09-eval.md) |
| 持续演进 | [10-evolve.md](./docs/architecture/10-evolve.md) |
| CLI 工具 | [11-cli.md](./docs/architecture/11-cli.md) |
| 多 Agent 编排 | [12-orchestration-multi-agent.md](./docs/architecture/12-orchestration-multi-agent.md) |
| RAG 流水线 | [13-rag.md](./docs/architecture/13-rag.md) |
| Advanced 扩展点 | [14-advanced.md](./docs/architecture/14-advanced.md) |
| 秘密脱敏 | [15-redact.md](./docs/architecture/15-redact.md) |
| 架构规则检查 | [16-evolve-check.md](./docs/architecture/16-evolve-check.md) |
| 测试层（含 cassette / chaos / perf / PBT / fuzz / 类型级） | [17-testing.md](./docs/architecture/17-testing.md) |

### 架构决策、威胁模型、测试计划

| 目录 | 内容 |
|------|------|
| [docs/adr/](./docs/adr/) | 10 份 ADR（ADR-0001..ADR-0010），MADR 4.0 格式 |
| [docs/security/](./docs/security/) | 每个 L3 子系统的 STRIDE 威胁模型 + OpenSSF Best Practices 自评 |

### 规范与 runbook

| 主题 | 文档 |
|---|---|
| Provider 适配器规范 | [provider-spec.md](./docs/provider-spec.md) |
| RAG 三套 conformance 规范 | [retriever-spec.md](./docs/retriever-spec.md) / [embedding-spec.md](./docs/embedding-spec.md) / [chunking-spec.md](./docs/chunking-spec.md) |
| 发布 runbook | [release.md](./docs/release.md) |
| 公开路线图 | [ROADMAP.md](./docs/ROADMAP.md) |
| 文档 i18n 策略 | [i18n-strategy.md](./docs/i18n-strategy.md) |
| pre-release 破坏性变更账本 | [MIGRATION.md](./MIGRATION.md) |

示例代码在 [`examples/`](./examples/)，每个主题一个可直接运行的脚本，`tools/smoke-test.mjs` 会在 CI 里把它们全部 smoke 一遍。

## 贡献

完整贡献指南见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。关键纪律：

1. **包管理器是 pnpm**——`npm` / `yarn` 不工作（`preinstall` hook 会拒）。Node `>= 22`（pnpm 10.24 用 `node:sqlite`，最低需求 v22.13），pnpm `>= 9`。
2. **近 100% 测试覆盖**是 `packages/core` 的硬门槛；CI 的覆盖率下限是 80% lines/statements、75% branches。
3. 触碰 `packages/` 的 PR **必须带 changeset**：`pnpm changeset`，挑 patch / minor / major 并写为什么。
4. 安全漏洞**不要开公开 issue**，按 [`SECURITY.md`](./SECURITY.md) 的私报流程走（GitHub Security Advisory 优先，邮箱备用）。
5. 行为守则见 [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)（Contributor Covenant v2.1）。

常用命令：

```bash
corepack enable                                 # 或 npm i -g pnpm@9
pnpm install                                    # 工作区装依赖
pnpm build                                      # tsup，输出 ESM + CJS + .d.ts
pnpm test                                       # 全工作区 vitest
pnpm test:coverage                              # 带覆盖率门槛
pnpm typecheck                                  # 全工作区 tsc --noEmit
pnpm lint                                       # 全工作区 eslint
pnpm changeset                                  # 用户可见改动必跑

# P1/P2 专项套件（不在 PR critical path）
pnpm --filter harness-one bench                 # tinybench 基线
pnpm --filter harness-one fuzz                  # fast-check ~10k 次/目标
pnpm --filter harness-one mutation              # Stryker（耗时几分钟）
pnpm --filter harness-one typecheck:type-level  # expect-type 编译期测试
pnpm size                                       # size-limit bundle 预算
pnpm check:tree-shake                           # 根桶 tree-shake 断言
pnpm docs:api                                   # TypeDoc 公开 API 报告
```

## 许可

MIT
