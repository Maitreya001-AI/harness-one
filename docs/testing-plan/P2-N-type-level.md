# Track N · 类型级测试（P2）

**预估工时**：3 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-N -b testing/track-N-type-level main
cd ../harness-one-track-N
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-N-type-level`）。harness-one 大量使用 discriminated union、branded type、条件类型——这些应该用类型系统自己证明，而不是靠单测。

**任务**：用 `expect-type` 加 7 条类型级断言，锁定关键类型契约 + 公开 API shape。

### 先读

```bash
grep -rn "AgentEvent\s*=\s*" packages/core/src --include="*.ts" | head
grep -rn "HarnessConfig\|branded\|__brand" packages/core/src --include="*.ts" | head -20
grep -rn "TraceId\|SpanId\|SessionId" packages/core/src --include="*.ts" | head
grep -rn "TrustedSystemMessage" packages/core/src --include="*.ts" | head
grep -rn "MemoryStoreCapabilities" packages/core/src --include="*.ts" | head
grep -rn "MetricsPort" packages --include="*.ts" | head
```

### 依赖

加 `expect-type` 到 `packages/core/package.json` devDeps（pin 最新）。`expect-type` 纯类型，零运行时影响。

### 目录

新建 `packages/core/tests/type-level/`：

```
tests/type-level/
  events.test-d.ts              # N1
  config-narrow.test-d.ts       # N2
  branded-ids.test-d.ts         # N3
  trusted-system.test-d.ts      # N4
  memory-capabilities.test-d.ts # N5
  metrics-port.test-d.ts        # N6
  public-api-shape.test-d.ts    # N7
  tsconfig.json                 # 指向 packages/core 编译
```

约定：`*.test-d.ts` 文件只含类型断言，vitest 会跳过（或配一个单独 `typecheck:type-level` 脚本跑 `tsc --noEmit`）。

### 7 条断言

#### N1 · `AgentEvent` exhaustive check
- `AgentEvent` 有 N 个 variant
- 写一个 `assertNever(x: never): never` helper（如 `packages/core/src/infra/` 已有，复用）
- 在测试里构造一个 `handle(e: AgentEvent)` 的 switch，所有 case 处理完调 `assertNever(e)`
- 如果将来加了新 variant 忘记处理，`tsc` 会 fail
- 用 `expectTypeOf<AgentEvent>().toEqualTypeOf<ExpectedUnion>()` 锁定 variant 集合

#### N2 · `HarnessConfig` discriminated narrow
- `HarnessConfig` 按 `provider: 'anthropic' | 'openai' | ...` narrow `client` 字段
- 测：`provider: 'anthropic'` 时 `client` 类型是 `AnthropicClient`，不是 `OpenAIClient`
- 测：未 narrow 时 `client` 是 union（编译期不该直接调 provider-specific method）

#### N3 · Branded ID 不可互赋
- `TraceId`、`SpanId`、`SessionId` branded type
- `expectTypeOf<TraceId>().not.toMatchTypeOf<SpanId>()`
- 构造 `const x: TraceId = someSpanId` 在 `// @ts-expect-error` 下能编译，证明错误被捕获

#### N4 · `TrustedSystemMessage` brand 来源锁定
- 只有 `createTrustedSystemMessage(...)` 能产出
- 测：`const x: TrustedSystemMessage = rawString` 编译失败（`@ts-expect-error`）
- 测：`const x = createTrustedSystemMessage(...)` 能赋给 `TrustedSystemMessage`

#### N5 · `MemoryStoreCapabilities` 条件类型
- 不同 capability 组合下 `get`/`set`/`query` 的存在性 narrow
- 测：`Store<{ query: true }>` 有 `query()`，`Store<{ query: false }>` 没有

#### N6 · `MetricsPort` 跨子路径同一性
- `@harness-one/core` 的 `MetricsPort` 和 `@harness-one/observe` 的 `MetricsPort` **必须是同一类型**
- 测：`expectTypeOf<CoreMetricsPort>().toEqualTypeOf<ObserveMetricsPort>()`
- `ARCHITECTURE.md` 已声明此不变量

#### N7 · 公开 API shape 锁定文件
- 一个 `public-api-shape.test-d.ts` 文件 import **所有** `harness-one` 公开子路径：
  ```ts
  import * as core from 'harness-one';
  import * as advanced from 'harness-one/advanced';
  import * as testing from 'harness-one/testing';
  import * as preset from '@harness-one/preset';
  import * as anthropic from '@harness-one/anthropic';
  import * as openai from '@harness-one/openai';
  ```
- 对每个 namespace 用 `expectTypeOf<typeof core>().toMatchTypeOf<ExpectedCoreShape>()`
- 定义 `ExpectedCoreShape` 为一个 reference type（把你要锁定的公开导出一一列出）
- **任何 breaking change 都必须改这个文件**——reviewer 在 PR diff 里一眼看出

### 运行

加 script `"typecheck:type-level": "tsc --noEmit --project packages/core/tests/type-level/tsconfig.json"` 到 `packages/core/package.json`，CI 加 step。

### File Ownership

- `packages/core/tests/type-level/**`（新建）
- `packages/core/package.json`（加 `expect-type` devDep + script）
- `.github/workflows/ci.yml`（加 type-level step）
- `docs/architecture/17-testing.md`（**必须更新**，描述 type-level 层及"API shape 锁定"机制）

**不要碰**：源码、其他 Track 路径。

### DoD / 验收

- [ ] 7 条类型级断言文件全绿
- [ ] `pnpm typecheck:type-level` 本地通过
- [ ] 手动引入破坏性变更（如删一个导出）时 `public-api-shape.test-d.ts` 会报错
- [ ] `MetricsPort` 一致性测试通过（若失败，说明 ARCHITECTURE.md 承诺破了，开 issue）
- [ ] `docs/architecture/17-testing.md` 更新

### 纪律

1. 类型级测试发现 shape 偏移→开 issue，不擅自改源码
2. `expect-type` 纯类型，不加运行时依赖
3. 改测试层架构，更新 `docs/architecture/`
4. Commit 粒度：依赖添加一个、每条断言一个

## ---PROMPT END---
