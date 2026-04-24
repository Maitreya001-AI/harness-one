# Testing（`harness-one/testing`）

> 独立子路径。给**测试代码**用的 mock `AgentAdapter` 工厂集合。

## 定位

`harness-one/testing` 专门收纳 mock adapter 工厂，让用户（以及 harness
自己的测试套件）写 AgentLoop 测试时不用装配真实 LLM 客户端。

**不用于生产代码。** 这些工厂：
- 不发事件到任何 observability port。
- 跳过 validation / guardrails / pricing 等产品路径上本该生效的环节。
- 不受和 `/core` 同级的 semver 稳定性承诺——签名可能随测试场景演化收紧。

如果你正在写的是 **真实 fallback 机制**、**单测 double 以外的 adapter**、
或者 **生产下行代码**，去 `/advanced` 找 `createFallbackAdapter`，或者直接
实现自己的 `AgentAdapter`。

## 公共 API

```ts
import {
  // mock 工厂
  createMockAdapter,
  createFailingAdapter,
  createStreamingMockAdapter,
  createErrorStreamingMockAdapter,
  type MockAdapterConfig,

  // cassette 层
  recordCassette,
  createCassetteAdapter,
  loadCassette,
  computeKey,
  fingerprint,

  // 契约套件
  createAdapterContractSuite,
  CONTRACT_FIXTURES,
  cassetteFileName,
  contractFixturesHandle,
  type AdapterContractSuiteOptions,
  type ContractTestApi,
  type ContractFixture,
} from 'harness-one/testing';
```

| 工厂 | 行为 |
|------|------|
| `createMockAdapter({ responses, usage? })` | 非流式 chat；按顺序返回 `responses` 的内容，末项重复；`.calls[]` 记录每次 `ChatParams` 用于断言 |
| `createFailingAdapter(error?)` | 总是抛出给定错误（或 `'Mock adapter failure'`）；用于 fallback / 错误分类测试 |
| `createStreamingMockAdapter({ chunks, usage? })` | 既有 `chat()` 又有 `stream()`；`stream()` 逐个 yield `chunks`，`chat()` 合并其中的 `text_delta` |
| `createErrorStreamingMockAdapter({ chunksBeforeError, error })` | 流式返回部分 chunks 然后抛错；用于 partial-stream 恢复测试 |
| `recordCassette(adapter, path)` | 包装真实 adapter，把每次 `chat()` / `stream()` 的入参 + 出参追加到 `path` 指向的 JSONL 文件 |
| `createCassetteAdapter(path, opts?)` | 把 cassette 文件加载成一个 `AgentAdapter`，按录制顺序（FIFO）回放；`opts.simulateTiming` 可按录制时的 SSE 间隔出块 |
| `createAdapterContractSuite(adapter, options)` | 以 `options.testApi`（调用方传入的 vitest `{describe, it, expect, beforeAll}`）注册约 25 条 AgentAdapter 契约断言；每条断言由 cassette 供给数据 |

所有 mock 工厂返回的 adapter 都附带 `.calls: ChatParams[]`，按调用顺序记录每次
参数快照——用于在测试里断言"LLM 实际收到了什么"。

## Cassette 层

Adapter 契约测试要**真实 provider 响应的形状**才有意义，但真实 API 又带预算、
网络、不稳定三重麻烦。Cassette 层把这两件事切开：

1. **录制**一次：`recordCassette(real, path)` 包装真实 adapter，一边正常返回
   响应给调用方，一边把 `chat()` / `stream()` 的入参指纹和出参（含 SSE 每块的
   相对时间戳）逐条 append 到 `path` 指向的 JSONL 文件。
2. **回放**无数次：`createCassetteAdapter(path)` 把文件加载进每个 key 的
   FIFO 队列，`chat()` / `stream()` 调用命中 key 就弹出下一条。

Key 的计算见 `computeKey(kind, fingerprint(params))`——只覆盖语义相关的字段
（messages、tools、`temperature` / `topP` / `maxTokens` / `stopSequences`、
`responseFormat`）。`signal`、`LLMConfig.extra` 之类的透传字段故意不进 hash，
这样 SDK 版本升级加个默认参数不会让所有 cassette 全红；代价是调用方自己负责
保持 `extra` 一致。

文件格式（`packages/core/src/testing/cassette/schema.ts`）：每行一条
`CassetteChatEntry | CassetteStreamEntry`，都带独立的 `version: 1` 字段，
读者（`loadCassette`）会拒绝未支持的 version。截断的末行会被容忍——允许录制
进行中的进程被打断，文件仍可回放。

Cassette 文件提交位置约定：

- `packages/anthropic/tests/cassettes/<fixture>.jsonl`
- `packages/openai/tests/cassettes/<fixture>.jsonl`

**零新运行时依赖**：cassette 层只用 `node:fs` / `node:crypto`。

## 契约套件

`createAdapterContractSuite(adapter, options)` 在 vitest 环境里注册一组与
adapter 实现无关的断言（≥ 20 条，目前 25 条），每条覆盖 `AgentAdapter`
接口的一个隐式承诺：

- `chat()` 返回的 `message.role === 'assistant'`，`content` 是字符串；
- `usage.inputTokens` / `outputTokens` 为非负有限数；可选的 `cache*Tokens`
  若出现同样限非负有限；
- `toolCalls[].{id,name,arguments}` 类型和非空字符串约束；`arguments` 非空
  时必须能 `JSON.parse`；
- `stream()` 至少 yield 一块、尾块是 `done`、`text_delta` 的 `text` 是字符串，
  `done` 带 usage；
- 带 tool 的 stream 在 `done` 之前至少 yield 一个 `tool_call_delta`，
  并在流中暴露过 id 和 name；
- 连续两次调用不共享内部状态（adapter 可重用）；
- `chat()` 不突变调用方传入的 `messages` 数组；
- 已 abort 的 `AbortSignal` 让 stream 立即 reject；`simulateTiming` 模式下
  中途 abort 同样 reject；
- 可选的 `countTokens()` 返回非负有限数；
- 顶层 `adapter.name` 是非空字符串。

### 为什么 `testApi` 要调用方注入

vitest 是 ESM-only 的、并且在模块求值时就抓 worker state。如果契约模块
静态 import vitest，`harness-one/testing` 就不能再被测试之外的 Node 脚本
（比如 `tools/generate-synthetic-cassettes.mjs`、`tools/record-cassettes.mjs`）
复用。所以我们把 `{ describe, it, expect, beforeAll }` 做成 `testApi` 选项，
由调用方的测试文件显式传入：

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createAdapterContractSuite } from 'harness-one/testing';
import { createAnthropicAdapter } from '@harness-one/anthropic';

createAdapterContractSuite(createAnthropicAdapter({ ... }), {
  cassetteDir: resolve(__dirname, 'cassettes'),
  testApi: { describe, it, expect, beforeAll },
});
```

契约套件**默认走 replay**（`mode: 'replay'`），所以跑 `pnpm test` 时根本不
摸 API。想录制新 cassette：

- `mode: 'record'` 或 `CASSETTE_MODE=record` 强制走真实 adapter（需要 API key）。
- `mode: 'auto'` 缺失 cassette 时 fallback 走真实 adapter，其余仍 replay。

### Fixtures

`CONTRACT_FIXTURES` 是 cassette 和断言共享的单一真源——每条 fixture 对应
一个 `.jsonl` 文件，通过 `cassetteFileName(fixture)` 推导文件名。目前 5 条：

| name                | kind   | expect                 | 用途                            |
|---------------------|--------|------------------------|---------------------------------|
| `chat-simple`       | chat   | text                   | 基础 Q→A 形状 + usage 断言      |
| `chat-with-system`  | chat   | text                   | 校验 system message 不被丢失    |
| `chat-tool-call`    | chat   | toolCall               | tool_use 响应形状               |
| `stream-simple`     | stream | text, doneChunk        | 基础流式序列 + `done` 尾块      |
| `stream-tool-call`  | stream | toolCall, doneChunk    | tool_call_delta 在 done 前顺序  |

## 离线 seed cassette 与 nightly drift

真实 API 记录既贵、又依赖 owner 本地 key。我们靠两件事让 CI 里也有可靠 fixture：

1. **`tools/generate-synthetic-cassettes.mjs`**：用 `computeKey` / `fingerprint`
   写手工 cassette 种子——shape 合法、能让契约套件断言全绿。Contributor
   fork 不用 API key 也能跑通测试。
2. **`tools/record-cassettes.mjs`** + **`.github/workflows/cassette-drift.yml`**：
   每天 06:00 UTC 用 repo secret `ANTHROPIC_API_KEY_CI` / `OPENAI_API_KEY_CI`
   重录 cassette，与仓库里的对 diff；若不同则通过 `peter-evans/create-issue-from-file`
   开一条 tracking issue 并把 diff 作为 artifact 上传，**不自动 commit**，由
   维护者决定是否 land 意图性的 re-record。

种子 cassette 是起点，drift workflow 是对 provider-side shape drift 的观测
系统；缺一侧就只剩"这合约是不是还真的反映了现实"这种问题。

### 本地 smoke

`pnpm smoke` 跑 `tools/smoke-test.mjs`，读 `.env.local` 里的 key，对两个 adapter
各发一次 `chat()` 和一次 `stream()`，打印 response / usage / 错误分类。**不
入 CI**——预算敏感，只在本地改过 adapter 源码之后作为"连线还活着"的确认。

## 为什么单独拆一个子路径

1. **语义边界**：`/advanced` 的所有其他导出都是生产代码可以直接 import
   的扩展点（middleware、resilient-loop、fallback-adapter、SSE、execution
   strategies、backoff、trusted system message、output parser、validators、
   pricing math）。Mock adapter 是 **test double**，公开一个导出点让用户
   一眼分清楚。
2. **Tree-shake 清晰**：生产 bundle 分析时，`harness-one/testing` 的符号
   出现在运行时导入图上就是 code smell——明确信号而不是藏在 `/advanced`
   的尾部。
3. **未来扩展**：如果需要加 `createRecordedAdapter`（重放真实 trace 的
   测试 harness）或 scenario builder，这个子路径就是落地点。

## 测试

- 工厂本身的行为契约：`src/testing/__tests__/test-utils.test.ts`
- Cassette 录制/回放：`src/testing/__tests__/cassette.test.ts`
- 契约套件自测（synthetic adapter + 手工生成的 cassette 目录驱动套件自己）：
  `src/testing/__tests__/contract-suite.test.ts`
- 作为依赖使用：harness 内部 ~20 个测试文件 + examples（middleware-chain /
  resilient-loop / sse-stream / multi-agent）通过 `harness-one/testing`
  消费。两个 adapter 包各有一条顶层 `tests/contract.test.ts` 接入上面的
  契约套件：`packages/anthropic/tests/contract.test.ts`、
  `packages/openai/tests/contract.test.ts`。

## 跨子系统集成测试层（`packages/core/tests/integration/`）

**目的**：harness-one 的单测（4500+）逐模块覆盖很好，但**单测和 E2E 之间
缺少一层"两到三个 subsystem 拼起来能跑"的证据**。这一层就在补这个空
白——每个 scenario 把真实 subsystem 装在一起跑，**只 mock LLM
adapter**（通过 `harness-one/testing` 的 `createMockAdapter` /
`createFailingAdapter`），其它 harness 代码都是真货。

Vitest 的 `include` glob 在 `packages/core/vitest.config.ts` 里已经扩到
`tests/**/*.test.ts`，所以新文件直接被 pick 上。共享 fixtures 放在
`tests/integration/fixtures/`（目前是 `temp-dirs.ts` 的 `useTempDir()` +
`mock-llm-responses.ts` 的 `textResponse` / `toolCallResponse` 辅助
函数）。

### 已实现的 scenario（Track D，P0）

| 文件 | 联合模块 | 固守的不变量 |
|------|----------|----------------|
| `agentloop-trace-cost.test.ts` (D1) | AgentLoop + TraceManager + CostTracker + tools registry | 四个口径（`AgentLoop.usage` / `done.totalUsage` / 逐 iteration span 的 token attrs / CostTracker 记录）在一次 run 里必须完全一致；tool span 的 `parentId` 必须指向同 iteration 的 iteration span |
| `guardrails-fail-closed.test.ts` (D2) | AgentLoop + GuardrailPipeline（input / tool_output / output 三个 hook 点） | input 块 → `guardrail_blocked` → `error` → `done(error)` 三段顺序稳定，adapter 未被调用；tool_output 块把结果重写为 `GUARD_VIOLATION` 桩，loop 继续 `end_turn`；output 块在最终回答阶段同 input；同一个 pipeline 在下一个 fresh loop 上的干净 run 必须没有任何污染 |
| `tools-parallel-error.test.ts` (D3) | AgentLoop + parallel ExecutionStrategy + tools registry | 三个并行 tool 里一个抛错，另外两个正常返回；worker pool 不卡；tool_result 事件顺序 = 原始调用顺序；抛错的 tool 通过 registry 的 `ToolFeedback` 结构化包裹（不是 uncaught）；loop 进入下一个 adapter turn 且没有顶层 `error` 事件 |
| `fallback-retry.test.ts` (D4) | AgentLoop adapter-retry + `createFallbackAdapter` + backoff | (a) 可重试 429 触发 `maxAdapterRetries` 次 `adapter_retry` span 事件，每次 `backoff_ms` 落在 `createBackoffSchedule` 同参数下的上下界里；(b) fallback adapter 配 `maxFailures: 1` 一次触发后变单向——后续 run 直接走备份 |
| `session-memory-relay.test.ts` (D5) | SessionManager + filesystem MemoryStore + ContextRelay | session TTL 过期抛 `SESSION_EXPIRED`，但磁盘上 relay 状态独立存活，新 relay 实例可加载到最后 checkpoint；`_index.json` 被 garbage bytes 破坏后 `query()` 仍能走 `listEntryFiles()` 返回所有 entry，`reconcileIndex()` 以"latest updatedAt wins per key"策略重建，之后 `write()` 再次 work |

### 纪律

- **不 mock harness 自家代码**。只 mock LLM adapter。任何想 mock trace
  manager / cost tracker / session / memory 的冲动都说明 scenario 粒度
  错了——拆更小或换更合适的 fixture，不要加 mock。
- **每个文件 < 200 行，单一责任**。一个 scenario 一个文件，描述一组紧密
  相关的不变量。
- **断言窄**。`it('accumulates cost monotonically across parallel tool
  calls')` 而不是 `it('works')`；不变量命名化，失败信号精确。
- **不吞错**：禁止 `try / catch + expect(true)` 模式。要么让错误真正抛出，
  要么显式 capture 并断言类型 + code。
- **文件所有权**：这一层只在 `packages/core/tests/integration/` 和
  `packages/core/vitest.config.ts`（如果需要扩 glob）工作。发现真实
  bug（非测试问题）时不擅自改源码，单独开 issue / 在 PR 里 flag 给
  owner。

## Import

```ts
import { createMockAdapter } from 'harness-one/testing';
```

## Mutation testing（Stryker）

单测通过不代表有效。行业经验显示，覆盖率到 80 % 的项目中，测试能实际
检测的代码变更通常只有 60–70 %。Mutation testing 自动往源码里注入小改动
（把 `>` 换成 `>=`、删掉分支、清空字符串等），再跑整套测试——如果没有
测试失败，就证明那块代码即便行为错误也不会被我们的套件拦住。

harness-one 在三个关键模块上运行 Stryker，作为传统覆盖率之外的第二道
质量门：

| 模块 | Baseline mutation score | 目标 | 状态 |
|------|------------------------|------|------|
| `packages/core/src/infra/validate.ts` | **100.00 %** (106/106 killed) | ≥ 85 % | ✅ 超标 |
| `packages/core/src/guardrails/pipeline.ts` | **82.26 %** (203 killed / 247 total) | ≥ 80 % | ✅ 达标 |
| `packages/core/src/core/agent-loop.ts` | **68.14 %** (136 killed / 204 total) | ≥ 80 % | ❌ **未达标**，列为后续 Track |
| `packages/core/src/core/iteration-runner.ts` | **51.28 %** (160 killed / 312 total) | ≥ 80 % | ❌ **未达标**，列为后续 Track |
| `packages/core/src/core/adapter-caller.ts` | **59.54 %** (103 killed / 173 total) | ≥ 80 % | ❌ **未达标**，列为后续 Track |

> **注**：`src/core/` 里的三个核心文件在本轮 Track K 中完成接入与基线测量，
> 但**尚未达到 80 % 目标**。存活突变主要集中在 observability 配置的
> 条件展开、trust-tag 推断、和 BoundedStream 字节计数逻辑——这些需要
> 针对 `observability` port、`trustedSystemMessage` 和 `cumulativeStreamBytes`
> 语义各写 10–20 个针对性测试。这是后续 Track 的工作；每周 CI 会持续
> 监测当前基线，直到写满为止。

三类等价突变（equivalent mutants）在源码中以 `// Stryker disable next-line`
明确标注，每处都注明了不可观察的原因（例如 `BoundedEventBuffer._evictedCount`
仅作为诊断钩子存在，从未被任何调用方读取；`.unref()` 调用仅影响进程退出
时 timer 的持有行为，而 `finally` 里的 `clearTimeout` 已提前释放）。

### 本地执行

```bash
pnpm --filter harness-one mutation                  # 三个模块全部跑
pnpm --filter harness-one mutation:validate         # 仅 validate.ts
pnpm --filter harness-one mutation:guardrails       # 仅 pipeline.ts
pnpm --filter harness-one mutation:core             # 仅 src/core/**
```

配置在 `packages/core/stryker.conf.mjs`：
- **不扫描全仓库**：`mutate` 只列上述三个 glob，避免 6 000 + LOC 的无意义
  突变测试成本；
- **增量模式**：`.stryker-tmp/incremental.json` 保留上一次的突变结果，
  二次跑 < 30 s；
- **break threshold = 80**：任何模块跌破 80 % 会让 `stryker run` 退出码
  非 0；
- **专用 vitest 配置**：`vitest.stryker.config.ts` 直接 inline tsconfig，
  绕开 monorepo 根目录 `extends` 链在 Stryker sandbox 中解析失败的问题。

### CI 集成

Mutation testing 不挂在 PR 上——它慢且昂贵，而且开发者迭代阶段加更多
噪音反而会劣化信号。流程：

1. **每周日 03:00 UTC**（`.github/workflows/mutation.yml`）跑一次全量，
   作为测试套件退化的告警机制；
2. **手动触发**（`workflow_dispatch`，可选 input 指定 `mutation:core` 等
   子任务）用于针对性诊断；
3. **HTML 报告**以 artifact 形式保留 30 天，可在 GitHub Actions UI 下载
   `stryker-report.zip` 查看每个存活突变的详细定位。

突破 break threshold 时，workflow 红——但这**不直接阻塞 PR**。期望的流程
是值班工程师在周一早上检查失败记录，如果是测试退化则开 issue；如果是
实际发现的产品 bug，按正常流程修复。

### 新增测试的纪律

- 测试名要描述突变场景，而非"模仿突变"。例：`it('accepts an entry with
  inputPer1kTokens exactly 0')` 直击 `n < 0` vs `n <= 0` 的边界，而不是
  `it('tests the < 0 mutation')`。
- 若突变揭示的是真 bug（代码 wrong、而非 test incomplete）——
  开 issue，**不在 mutation-testing 分支顺手修**。Bug 修复应该在独立 PR
  里、带修复前后的测试对比。
- Equivalent mutant 的判定要苛刻：只有当"mutant 翻转后没有任何公开 API
  信号会变"才允许加 `// Stryker disable` 注释。能写测试证明等价性的，
  都算可杀。

## Chaos 测试

**定位**：harness-one 的差异化卖点之一是"出问题时表现正确"——fallback
adapter、resilient loop、circuit breaker、`maxStreamBytes`、guardrail
fail-closed。没有故障注入测试，这些功能等于没测。

Chaos 层专门用来在真实故障序列下验证**聚合不变量**（比如"无 span 泄漏"、
"cost 账本自洽"、"session 锁一定释放"），而不是单点行为。

### 基础设施：`createChaosAdapter`

```ts
import { createChaosAdapter } from 'harness-one/testing';

const adapter = createChaosAdapter(innerAdapter, {
  seed: 42,                     // 必传，种子决定整条注入序列
  errorRate: { 429: 0.15, 503: 0.15 },  // HTTP 级错误
  streamBreakRate: 0.2,         // 流式中途断开
  toolArgBloatRate: 0.1,        // tool_call_delta 超 `maxToolArgBytes`
  hangRate: 0.05,               // 整调用 hang，靠外部超时回收
  invalidJsonRate: 0.15,        // tool args 返非法 JSON
});
```

每项故障独立、可组合。Adapter 同时暴露：

- `.config`：原始配置回读。
- `.recorder: ChaosRecorder`：每次调用的 `InjectionRecord` 列表（`kind`、
  `path`、`callNumber`、`at`），scenario 断言时用它证明故障真的注入了。

**种子与 PRNG**。注入决策全部走 `createSeededRng()`（mulberry32，32-bit
状态，确定性），**禁止在 chaos 层使用 `Math.random`**。同一 `seed` + 同一
inner adapter + 同一调用顺序 → 位对位一致的注入记录。CI 里通过
`CHAOS_SEED` 控制种子；本地复现 flake 时只需 `CHAOS_SEED=42 pnpm test`。

### Scenario 套件（`packages/core/tests/chaos/`）

每个 scenario 跑长序列（50–200 次 run），断言**聚合**不变量：

| ID | 场景 | 注入 | 核心不变量 |
|----|------|------|------------|
| H1 | 50 run | 15%/15% 混合 429/503 | 终态可达、无 span 泄漏、cost 自洽、breaker 触发后 fallback 接管 |
| H2 | 200 stream | 20% 中途断开 | 终态可达、无 span 泄漏、所有错误落入已分类的 `HarnessErrorCode`（无 generic Error） |
| H3 | 100 stream | 10% tool_use 超限 | 超限 case 抛 `ADAPTER_PAYLOAD_OVERSIZED`，非超限 case `end_turn` |
| H4 | 100 run | 5% hang > timeout | 每次 hang 在 `1.5 × timeout` 内 abort、session 锁 100% 释放、错误码一致 |
| H5 | 100 tool | 15% 非法 JSON | 非法 JSON 走 `tool_result` 错误 envelope、`reconcileIndex()` 幂等、无半写入 |

### 聚合断言库（`tests/chaos/assertions.ts`）

Scenario 跑完调用一组通用断言：

- `assertAllRunsReachedTerminalState(runs)` — 所有 run 都发过 `done`，loop
  status 不卡在 `running`/`idle`。
- `assertNoActiveSpans(traceManager)` — `getActiveSpans()` 为空。
- `assertCostConsistency(costTracker, runs)` — recent-window 总和不超过
  per-trace cumulative 和，每条记录有限且非负。
- `assertSessionLocksReleased(sessionManager, sessionIds)` — 每个未被销毁的
  session 状态不是 `locked`。
- `assertMemoryStoreConsistent(store)` — 连续两次 `reconcileIndex()` 返回
  相同 `scanned`/`keys`，证明无悬空半写入。

### 运行

```bash
# 完整 chaos 套件（单 run 预算 <60 秒）
pnpm -F harness-one test -- chaos

# 复现 flake：固定种子复跑
CHAOS_SEED=42 pnpm -F harness-one test -- chaos

# 稳定性 sweep：10 个种子都过才算稳定
for i in {1..10}; do CHAOS_SEED=$i pnpm -F harness-one test -- chaos || break; done
```

CI 里固定种子跑一次；稳定性 sweep 由 DoD 在每次改 chaos 层时本地执行。

### 边界

- Chaos scenario **不修** harness 源码。发现真实 bug 另开 issue，scenario
  不做兜底。
- 不引入新运行时依赖；PRNG、assertion 库都在 harness 自身代码里。
- `packages/core/src/testing/chaos/**` 属于 **test-only** 子路径的扩展；
  生产 bundle 不会拉入。

## 类型级测试层（Track N · P2）

Chaos 层验证**运行时**行为；类型级测试层验证**编译期**契约。两条测试层
互不重叠——前者在真实故障序列下检查聚合不变量，后者确保 discriminated
union、branded type、条件类型、公开 API shape 在重构时不会静默漂移。

### 位置

```
packages/core/tests/type-level/
  events.test-d.ts              # N1 · AgentEvent exhaustive switch + variant lock
  config-narrow.test-d.ts       # N2 · HarnessConfig discriminated narrow + XOR
  branded-ids.test-d.ts         # N3 · TraceId/SpanId/SessionId non-assignability
  trusted-system.test-d.ts      # N4 · TrustedSystemBrand source lock
  memory-capabilities.test-d.ts # N5 · MemoryStoreCapabilities ↔ method pairing
  metrics-port.test-d.ts        # N6 · MetricsPort cross-subpath identity
  public-api-shape.test-d.ts    # N7 · 公开 API shape 锁定文件（canonical sentinel）
  tsconfig.json                 # 专用 tsconfig，paths 映射到每个子路径的 src
```

文件后缀 `.test-d.ts` 与 vitest 默认匹配的 `*.test.ts` 不冲突——vitest
不会把它们当测试跑，它们是**纯类型断言**。

### 运行

```bash
pnpm --filter harness-one typecheck:type-level
```

脚本定义在 `packages/core/package.json`：
`tsc --noEmit --project tests/type-level/tsconfig.json`。

CI 在 `.github/workflows/ci.yml` 的 `build` job 里作为独立 step 跑，
失败直接阻断合并。

### 约定

1. **纯类型，零运行时**：依赖只有 `expect-type`（pinned），pure-type
   包，不会进 bundle。
2. **不动源码**：类型级测试发现 shape 偏移 → 开 issue，交由专门的
   PR 处理。`tests/type-level/` 只反映现状，不承担修复。
3. **tsconfig 独立**：继承 `tsconfig.base.json` 但关掉
   `noUnusedLocals` / `noUnusedParameters`（断言会引入"看起来没用"
   的局部声明），`moduleResolution: Bundler`，并用 `paths` 把
   `harness-one`、`harness-one/<subpath>`、`@harness-one/<pkg>` 映射
   到各包 src 入口，避免依赖 `dist/`。

### N7 · API shape 锁定机制

`public-api-shape.test-d.ts` 是**公开 API 的哨兵**：

- 用 `import * as ns from '<subpath>'` 把每个公开子路径作为 namespace
  导入。
- 对每个 namespace 声明一个 `ExpectedXxxShape` 参考类型，列出该子路径
  **已经承诺**的值导出（类型导出由 N1–N6 分别锁定）。
- 用 `expectTypeOf<typeof ns>().toMatchTypeOf<ExpectedXxxShape>()` 检查。

行为特性：

- **加导出**不触发报错（`toMatchTypeOf` 接受超集）。这是有意的——
  新增导出是 additive change，不该卡 CI。
- **删/重命名/收紧签名**触发 `tsc` 报错，且错误信息会点名具体的
  expected 字段，reviewer 在 PR diff 里一眼能看出哪个子路径被动了。
- reviewer 规则：任何对本文件的 diff 都是 public-API 变更，必须进
  CHANGELOG + changeset。

### N6 · MetricsPort 不变量

`MetricsPort` 的规范位置是 `packages/core/src/core/metrics-port.ts`
（L2），公开出口在 `harness-one/observe`。ARCHITECTURE.md 承诺跨子路径
同一性——`harness-one` 根 barrel 和 `harness-one/observe` 看到的必须
是同一个类型。

`metrics-port.test-d.ts` 用 `expectTypeOf<A>().toEqualTypeOf<B>()` 锁
这个承诺。若失败，说明有人在非规范位置又声明了一份 `MetricsPort`，
**开 issue**，不要通过放宽断言来"修复"。

### 和运行时测试的分工

| 测试层 | 位置 | 跑法 | 抓什么 |
|--------|------|------|--------|
| 单元测试 | `packages/*/src/**/__tests__/*.test.ts` | `pnpm test` (vitest) | 行为、边界 |
| Chaos 场景 | `packages/core/tests/chaos/*.test.ts` | `pnpm -F harness-one test -- chaos` (vitest) | 故障注入下的聚合不变量 |
| 类型级测试 | `packages/core/tests/type-level/*.test-d.ts` | `pnpm --filter harness-one typecheck:type-level` (tsc) | 类型契约、变体穷举、API shape |
| 测试 double | `harness-one/testing` | 作为被测依赖使用 | — |

类型级测试的价值在于**把能用类型系统证明的东西从单测里踢出去**：
`AgentEvent` 是否穷举、`TraceId`/`SpanId` 是否互相不可赋值、公开 API
shape 有无悄悄漂移——这些在运行时根本跑不到，写单测是浪费。

## Perf baseline

除了测试工具子路径，`packages/core` 还维护了一套独立的 **perf 回归基线**，
专门用于防退化而非炫耀"快"。落地文件在
`packages/core/tests/perf/`，由 `.github/workflows/perf.yml` 在每个 PR
上自动跑。

### 五条基线

| id | 指标 | 对象 |
|----|------|------|
| I1 | `agentloop_overhead_p50_ns`、`agentloop_overhead_p95_ns` | 空 `AgentLoop.run()` 单迭代开销（零延迟 mock adapter） |
| I2 | `trace_10k_span_peak_heap_mb` | `createTraceManager` 写 10k span 后的 heap 峰值 |
| I3 | `fs_store_get_p50_us`、`fs_store_query_p95_ms` | `FileSystemStore` 在 2k entries 下的 get / query 延迟 |
| I4 | `stream_aggregator_10mb_total_ms` | `StreamAggregator` 处理 10 MB 文本流总耗时 |
| I5 | `guardrail_pipeline_10x_p99_us` | 10-guard pipeline（5 input + 5 output）跑 1k 消息的 p99 |

每条 case 独立文件（`cases/*.ts`），通过标准 `PerfCase` 接口向 runner 汇报
`{ metric, unit, value, iterations, timestamp }`。输入全部 seed-驱动，temp
dir 每次重建；不联网、不依赖外部状态。

### 漂移 gate

- **`pnpm bench`**：跑全套 → 和 `tests/perf/baseline.json` 逐项对比 → `> +15 %`
  失败（perf 回退），`< -15 %` 警告（大概率 bench 本身坏了或停止测量真实
  代码）。退出码非零时 CI job 变红。
- **`pnpm bench:update`**：跑全套 → 覆盖 `baseline.json`。**Owner-only**。
  CI workflow 里有一步 diff 检查，如果 CI 运行期间 `baseline.json` 被
  修改就主动失败——防止误配的 `UPDATE_BASELINE` 环境变量悄悄 drift baseline。

### 平台门控

`baseline.json` 的数字**只在 Ubuntu + Node 20 上**有比较意义。文件系统 /
allocator / JIT 在不同平台的差异会让部分指标（特别是 I3）相差 3–10×。
Runner 会把当前 `process.platform` + `process.version` 主版本号和
`baseline.json` 里的记录对比：

- 匹配 → 跑 ±15% 门控。
- 不匹配 → 表格照样输出，但门控**跳过**，GitHub Step Summary 标记为
  `:information_source: platform mismatch`。

所以 macOS / Windows 本地可以 smoke-test case 逻辑，但提交到 baseline 的
数字必须在 CI image 上重跑。Merge 第一次引入 perf 体系的 PR 之后，owner
应该手动在 Ubuntu + Node 20 上执行一次 `pnpm bench:update` 并单独 commit
新 baseline，CI 才真正开始 gate。

### 时间预算

全套目标 `< 2 分钟`（Ubuntu CI）。I3 占大头——`query()` 扫描全部 entry 文件，
代价随 entries × queries 线性增长；当前选择的 2 k entries × 20 queries 在
Ubuntu 上 ≲5 s，慢文件系统（macOS APFS、加密盘、CI cache mount）上可能跑到
30 s+，本地迭代时用 `--case=` 跳过即可。

其他 case 都在亚秒级（I1、I4、I5）或毫秒级（I2）。

### 稳定性策略

微秒级指标（I1 p95、I5 p99、I3 get p50）对单次 GC 或调度事件非常敏感。
每条 case 都跑 N 轮同样的采样并**发布各轮 percentile 的 min**（tinybench
风格的 outlier-drop reducer）。这不是伪造数字——min 代表 steady-state，
背景进程抖动留在没有被发布的那些轮里，baseline 稳定性换 5-10× 可接受的
复现性。

### 详细说明

跑法、baseline 格式、regenerate 流程：`packages/core/tests/perf/README.md`。

## Property-based Testing（PBT）

除了上面的 mock adapter 层，`packages/core` 还维护一套基于
[`fast-check`](https://fast-check.dev) 的 property 测试，针对"难以用手写 case 穷举"
的核心不变量。每条 property 紧邻被测模块的 `__tests__/` 目录，文件名以
`*.property.test.ts` 结尾（方便用 glob 单独挑出或排除）。

`fast-check` 只进 `@harness-one/core` 的 `devDependencies`，**不进运行时依赖图**
——在发布出去的包里不会出现。

### 覆盖的不变量

| ID | 模块 | 不变量 |
|----|------|--------|
| J1 | `core/agent-loop` | 状态机转换图合法；`disposed` 一旦到达就是吸收态；终态不可回流 |
| J2 | `core/conversation-pruner` | 开头 system 消息全部保留；幂等（`prune(prune(x)) === prune(x)`）；长度上限（含已记录 quirk） |
| J3 | `infra/backoff` | `delay(n)` 单调非递减；`delay(n) ≤ maxMs`；`delay(0)` 非负有限 |
| J4 | `infra/lru-cache` | `size ≤ capacity`；`onEvict` 次数 = 实际淘汰次数；最近 touch 的 key 不会成为下一个被淘汰者 |
| J5 | `observe/cost-tracker` | token/cost 单调非递减；`updateUsage` 不能降低 token；Kahan 求和精度 |
| J6 | `core/pricing` | 非负输入 → 非负有限输出；空 usage → 0；per-1k 单位换算正确 |
| J7 | `core/stream-aggregator` | 任意 unicode（含代理对拆包、孤立代理）下的 UTF-8 字节数等于 `Buffer.byteLength` |
| J8 | `memory/fs-store` | 随机 write/delete/compact + crash 注入（孤儿 entry / 过时 index）后，`reconcileIndex()` 能恢复一致 |

### 运行参数

- 一般 property：`numRuns` 至少 100。
- 关键 property（J7 unicode 计数）：`numRuns = 500`。
- I/O 敏感 property（J8，`fc.commands` 状态机）：`numRuns = 100, maxCommands = 5`
  ——文件系统操作每跑一条命令就是一次 atomic rename，numRuns 过高会拖慢整个套件
  并把相邻 fs-store 测试挤进 `ENOTEMPTY` 的竞态。
- 整个 PBT 套件目标 wall-clock < 30 秒，实测 ~2 秒。

### Failure reproduction

所有 property 都支持通过环境变量重放失败 seed：

```bash
FC_SEED=<seed> pnpm --filter harness-one exec vitest run <path>
```

fast-check 在 property 失败时会把 seed + path 打到错误信息里，直接拷贝 seed
环境变量就能复现——不需要手动改源码里的 `seed:` 参数。

### 跑法

PBT 走 `pnpm test`（与常规单测同一条命令），CI 不需要额外 job。
如果只想跑 PBT：

```bash
pnpm --filter harness-one exec vitest run '**/*.property.test.ts'
```

### 新增 property 指引

1. Arbitrary 用 `fc.oneof` 混边界（空字符串、NaN、0、maxInt 等）——不要偏向
   happy path；`fc.fullUnicodeString` 在 fast-check 4.x 已改名为
   `fc.string({ unit: 'binary' })`，选这个才能跑到 lone surrogate。
2. 不要为了让 PBT 通过去改源码；如果 property 揪出源码 bug，在 PR 描述里
   flag，不擅自修。J2 的"长度上限 quirk"就是走这个通道发现的。
3. Commit 粒度：每条 property 单独一个 commit（fast-check 依赖添加也独立
   一个 commit）；方便 bisect 时 diff 失败面。
