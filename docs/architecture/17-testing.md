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
  createMockAdapter,
  createFailingAdapter,
  createStreamingMockAdapter,
  createErrorStreamingMockAdapter,
  type MockAdapterConfig,
} from 'harness-one/testing';
```

| 工厂 | 行为 |
|------|------|
| `createMockAdapter({ responses, usage? })` | 非流式 chat；按顺序返回 `responses` 的内容，末项重复；`.calls[]` 记录每次 `ChatParams` 用于断言 |
| `createFailingAdapter(error?)` | 总是抛出给定错误（或 `'Mock adapter failure'`）；用于 fallback / 错误分类测试 |
| `createStreamingMockAdapter({ chunks, usage? })` | 既有 `chat()` 又有 `stream()`；`stream()` 逐个 yield `chunks`，`chat()` 合并其中的 `text_delta` |
| `createErrorStreamingMockAdapter({ chunksBeforeError, error })` | 流式返回部分 chunks 然后抛错；用于 partial-stream 恢复测试 |

所有工厂返回的 adapter 都附带 `.calls: ChatParams[]`，按调用顺序记录每次
参数快照——用于在测试里断言"LLM 实际收到了什么"。

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
- 作为依赖使用：harness 内部 ~20 个测试文件 + examples（middleware-chain /
  resilient-loop / sse-stream / multi-agent）通过 `harness-one/testing`
  消费。

## Import

```ts
import { createMockAdapter } from 'harness-one/testing';
```

---

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
