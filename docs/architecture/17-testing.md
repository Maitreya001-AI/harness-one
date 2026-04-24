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

## Fuzz 测试（`packages/core/tests/fuzz/`）

> Property-based fuzz 套件，覆盖 4 个高风险 parser。和常规单测分开跑，
> 避免把 ~10k 次迭代塞进 PR 关键路径。

### 目标

| Target | 文件 | numRuns | 触及代码 |
|--------|------|---------|---------|
| O1 · tool arguments parser | `tool-args-parser.fuzz.test.ts` | 5000 | `core/output-parser.ts`、`tools/registry.ts` |
| O2 · guardrail input | `guardrail-input.fuzz.test.ts` | 2000 | `guardrails/pipeline.ts` + 4 个内置 guard |
| O3 · SSE stream | `sse-stream-parser.fuzz.test.ts` | 3000 | `core/sse-stream.ts`、`core/stream-aggregator.ts` |
| O4 · prompt template | `prompt-template.fuzz.test.ts` | 2000 | `prompt/builder.ts`、`prompt/registry.ts` |

每个 target 都配一个 `tests/fuzz/corpus/<target>/` 目录，里面存 10–20 个
"已知恶意样本"（深嵌套 JSON、proto pollution、零宽字符、畸形 SSE
分片、模板占位符注入等）。seed corpus 先跑，fast-check 属性再跑，两层
双保险。

### 执行

本地：

```bash
pnpm --filter harness-one fuzz
```

CI：不挂 PR，走独立 workflow（`.github/workflows/fuzz.yml`），
定时 `cron: '0 4 * * *'` + `workflow_dispatch` 手动触发。

失败时 fast-check 会打印 `seed: <n>` 和 shrunk counter-example；
复现步骤：

```bash
# 把 seed 塞进 fc.assert 的 { seed: <n> } 选项，或者 FC_SEED=<n> 跑
FC_SEED=<n> pnpm --filter harness-one fuzz -- <path-to-test> --reporter=verbose
```

### 断言的生存属性

- **P1（survival）**：对任意输入，parser 永不抛未捕获异常——要么返回
  `HarnessError`/`ToolResult(error)`/`PipelineResult(passed=false)`，
  要么成功返回结构化值。
- **P2（no prototype pollution）**：parser 输出的对象永远不会在
  `Object.prototype` 上留痕；`__proto__` / `constructor` / `prototype`
  键在 `infra/redact.POLLUTING_KEYS` 里被显式拒绝。
- **P3（size enforcement）**：超过 `MAX_STREAM_BYTES` /
  `maxJsonBytes` / `MAX_ARG_BYTES` 的 payload 以结构化错误拒绝，
  不 panic、不 OOM。
- **P4（no prompt-leak）**：模板渲染器只替换声明过的变量，变量值里的
  `{{nested}}` 被 sanitise 剥除，不会递归展开。

### 已知发现

真正的 bug 走 coordinated disclosure 流程（见 `SECURITY.md`），本 track
不在同一 PR 修。跟踪清单：`packages/core/tests/fuzz/FINDINGS.md`。当前
条目：

- `F-O4-01` — `createPromptRegistry().resolve()` 对 `Object.prototype`
  上的键名（`toString` / `valueOf` / `constructor` / …）走 `in`-操作符
  fallback，抛 `TypeError` 而非 `HarnessError`。属性测试当前 filter
  掉这些名字以保持绿，修复合并后把 filter 去掉。

### 为什么和单测分开

1. **时间预算**：`pnpm test` 需要在 PR CI 每次跑满，fuzz 一轮 12k+
   迭代太慢。定时 + 手动触发能容忍分钟级预算。
2. **覆盖率阈值**：`vitest.config.ts` 主配置对 `src/**/*.ts` 强制 80/75
   阈值；fuzz 测试跑的是生存属性，并非测试新代码，分开配置
   （`vitest.fuzz.config.ts`）避免把覆盖率要求混进 fuzz。
3. **语义边界**：fuzz 抓的是 parser 幸存度，不验证"正确结果"；和
   单测的正确性断言语气完全不同，混在一起读起来更乱。

