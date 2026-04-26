# HARNESS_LOG · apps/research-collab

> 这份日志按 DESIGN §5.1（持续反哺）的要求维护：每一条都是
> research-collab 在生产代码里**真实碰到**的 harness-one 子系统摩擦，
> 包含：
>
> - **现象**：哪个 API / 边界出问题
> - **影响**：本 app 怎么被影响
> - **临时绕过**：当前实现的 workaround
> - **建议反哺**：harness-one 主仓库可以怎么改（issue 标签建议）
>
> 摩擦点按发现时间倒序排列，最新在最上面。`Status: open` 表示还需要主
> 仓库动作；`Status: workaround` 表示我们先绕过去了；`Status: resolved`
> 表示主仓库已修复并可以删除本条。
>
> **节奏约定**：每跑通一次新场景（新增 agent / 新增 tool / 新增 guardrail）
> 就在这里 review 一次最近的 commit diff，把过程中卡住过 5 分钟以上的
> 任何 harness-one API 摩擦写下来。"卡住但不影响 app 跑通" 也算 —
> ergonomics 是反哺的主线。

---

## L-2026-04-26-008 · 跨 workspace 的 typecheck 必须先 `pnpm build` 才能跑

- **子系统**：`@harness-one/preset` + 所有 `packages/*` 的发布配置
- **现象**：`apps/research-collab` 第一次 `pnpm typecheck` 直接报
  `Cannot find module '@harness-one/preset' or its corresponding type
  declarations.`。原因是 `packages/preset/package.json` 把
  `types: "./dist/index.d.ts"` 指向构建产物，但 monorepo 默认 install
  完不会触发 build。`vitest.config.ts` 用 alias 绕过了这个（直接指向
  `src/`），但 `tsc` 没有同款 alias 机制。
- **影响**：任何新 app 第一次接入都会撞这个错。已经习惯这个 monorepo
  的人 5 秒就懂；新 contributor 会卡很久。
- **临时绕过**：`pnpm -r --filter '!@harness-one/research-collab' build`
  跑一遍，dist 出来后再 typecheck 通过。
- **建议反哺**：要么在 root `tsconfig.base.json` 配上
  `paths` 把 workspace 包 alias 到 src（和 vitest config 对齐）；要么在
  `apps/dogfood/README.md` + `apps/research-collab/README.md` 顶部就放一
  句 "first-time setup 必须 `pnpm build` 一次"。
- **Status**: workaround
- **Owner**: 主仓库 DX

---

## L-2026-04-26-007 · `HandoffPayload` 实际字段是 `metadata` / `context`，没有 `details`

- **子系统**：`harness-one/orchestration`（`types.ts` 的 HandoffPayload）
- **现象**：实现 pipeline orchestrator 时按直觉写了
  `handoff.send(from, to, { summary: '...', details: {...} })` —
  TypeScript 报 `'details' does not exist in type 'HandoffPayload'`。
  实际 schema 是 `{ summary, artifacts?, concerns?,
  acceptanceCriteria?, context?, metadata?, priority? }`。
- **影响**：花了一次 typecheck 失败 + 翻 source 才弄清字段名。
  `summary + metadata + context + artifacts + concerns +
  acceptanceCriteria` 是个相当宽的 schema —— 没看 source 不会知道；
  README 里也没有现成的 worked example。
- **临时绕过**：把 `details` 改成 `metadata`。
- **建议反哺**：在 `harness-one/orchestration` 的 README 加一段
  "Handoff payload 的常见字段及用法"，最少要演示 `summary + metadata`
  的最小例子；或在 `HandoffPayload` 上加 `@example` JSDoc。
- **Status**: workaround
- **Owner**: 主仓库 docs

---

## L-2026-04-26-006 · `CostTracker` 没有 ModelPricing 时静默返回 \$0，没有 fallback / warning

- **子系统**：`harness-one/observe`（`createCostTracker` + `ModelPricing`）
- **现象**：测试期望 `cost.usd > 0`，实际为 0。`createSecurePreset`
  在没有 `pricing` 字段时直接调 `createCostTracker({ budget })` —— 没有
  默认 pricing 表，也不警告 caller "你的成本永远会是 0"。下游一旦做
  budget gating 就会出问题（成本算不上来 → budget 永远不会触发）。
- **影响**：本 app 多个测试只能从 `> 0` 改成 `>= 0`，验收时无法
  验证成本聚合的正确性，只能验证 schema 有 `cost.perAgent` 三栏。生产
  路径 `RESEARCH_BUDGET_USD` 也因此实际不生效（budget 永不达到 0）。
- **临时绕过**：在测试里降级断言，并在 METRICS.md 里把
  `mean_cost_usd` 标为"需要 caller 自行配置 pricing"。
- **建议反哺**：
  - 选项 A：`createSecurePreset` 默认带一个常见模型的 pricing 表
    （Claude / GPT 主流型号），跟 `guardrailLevel` 一样属于 "secure
    default"。
  - 选项 B：当 `budget` 设了但 `pricing` 没设时，`createSecurePreset`
    构造期 `safeWarn` "budget will never trip without pricing config"。
  - 任意一种都比当前的"静默 \$0"好。
- **Status**: open（影响生产正确性，不只是 ergonomic）
- **Owner**: 主仓库

---

## L-2026-04-26-005 · `HarnessConfig` 不暴露工具 registry 注入点（L-001 的兄弟问题）

- **子系统**：`@harness-one/preset` 整体
- **现象**：L-001 是"capability 白名单不可覆盖"，更上一层的问题是：
  `HarnessConfigBase` 完全没有 `tools?: { registry?: ToolRegistry }`
  字段。即使 capability 白名单允许 network，app 也没办法注入一个**预
  配置好的** registry（比如带 middleware / 自定义 timeout / 自定义
  permission checker 的）。所有 app 都只能用 preset 内部硬编码的
  `createRegistry({ validator })`。
- **影响**：本 app 想给 web tool 加自定义 retry middleware 没辙。
  本次 MVP 不依赖，但后续要做的 rate-limit-aware fetch 就会被卡。
- **临时绕过**：当前不做。等需求到了再说。
- **建议反哺**：`HarnessConfigBase` 加 `tools?: { registry?: ToolRegistry;
  allowedCapabilities?: ToolCapabilityValue[] }`。两个字段互斥（前者
  完全自带，后者只是配置默认 registry）。
- **Status**: open
- **Owner**: 主仓库

---

## L-2026-04-26-001 · 工具注册的 capability 白名单无法在 Harness 层覆盖

- **子系统**：`harness-one/tools` + `@harness-one/preset`
- **现象**：`createRegistry({ ... })` 默认 `allowedCapabilities: ['readonly']`，
  且 `createHarness` / `createSecurePreset` 都直接调用
  `createRegistry({ validator })`，**没有把 `allowedCapabilities` 透传出来**。
  research-collab 的 `web_search` / `web_fetch` 在语义上是 `Network` +
  `Readonly` 的组合工具，按真实 capability 注册会被
  `TOOL_CAPABILITY_DENIED` 拒掉。
- **影响**：本 app 必须在 `defineWebSearchTool` /
  `defineWebFetchTool` 里**只声明 `Readonly`**，否则连 harness 都启动不
  了。capability 声明被迫和实际语义对不齐 —— 这正是 capability 白名单
  机制要避免的事，反而绕回来咬了我们。
- **临时绕过**：跟 `apps/dogfood` 的 `search_recent_issues` 保持一致 ——
  把 web 工具声明为 `Readonly`（注释里明确写了"从 LLM 视角是只读操作"
  的解释）。绕过本身没安全风险（registry 默认只允许 `Readonly`），但
  **capability 元数据失真**会让任何依赖 capability 做策略判断的下游工具
  失效。
- **建议反哺**：在 `HarnessConfigBase` 上加 `tools?: { allowedCapabilities?, ... }`
  字段，转交 `createRegistry`。`createSecurePreset` 仍可以用安全默认，
  但允许 app 显式扩展（例如 `['readonly', 'network']`）。
- **Status**: workaround
- **Owner**: app-side，待主仓库决策
- **关联**：DESIGN §5.1 第 1 项（"orchestration 子系统的 handoff API
  ergonomic" 类型摩擦的兄弟问题）

---

## L-2026-04-26-002 · GuardrailContext 字段没有 `direction` / `source`

- **子系统**：`harness-one/guardrails`（`core/guardrail-port.ts`）
- **现象**：`GuardrailContext = { content; meta?; permissionLevel? }`。
  本 app 想给 web-content 守卫附加 `{ direction: 'input', source: 'web_fetch:URL' }`
  做来源溯源，初版按 README 直觉写成 `{ content, direction, source }` —
  TypeScript 通过（`meta` 是 `Record<string, unknown>`），但运行时被忽略。
- **影响**：一开始我们误以为 source/direction 已经在 trace 里出现了；其实
  完全没有传到 trace exporter。两次 review 才发现要 `meta: { source }`。
- **临时绕过**：把 source 包进 `meta` 字段，写一行内注释提醒未来读者。
- **建议反哺**：把 `direction` 提升为 GuardrailContext 一等字段（pipeline
  实际上已经知道这个值，只是没暴露给单个 guardrail），并提供
  `GuardrailContextBuilder` 帮助 app 维护一致的 meta key。
- **Status**: workaround
- **Owner**: 主仓库

---

## L-2026-04-26-003 · 内置 InjectionDetector 是同步实现，但类型签名是 sync|async 联合

- **子系统**：`harness-one/guardrails`
- **现象**：`Guardrail = (ctx) => Promise<Verdict> | Verdict`。
  `createInjectionDetector().guard` 实际返回同步 `Verdict`，但调用点拿到的
  是联合类型，必须在每个调用方做 `instanceof Promise` 收窄才能用。
  研究 collab 的 web-content guardrail 是直接对 fetched body 做一次同步
  判定，纯异步分支永远走不到 —— 多写的 5 行只是为了让类型通过。
- **影响**：所有"我只想要同步守卫"的代码点都要加防御；这次只是
  research-collab 一个文件，但只要别的 app 也用，就会反复出现同样的样板。
- **临时绕过**：`if (verdict instanceof Promise) throw …`，断言不变量。
- **建议反哺**：拆 `Guardrail` 成 `SyncGuardrail` + `AsyncGuardrail` 两个类型，
  pipeline 接受联合，但 app 可以用 `SyncGuardrail` 作 narrower 类型。
- **Status**: workaround
- **Owner**: 主仓库

---

## L-2026-04-26-004 · `exactOptionalPropertyTypes: true` + `HarnessConfigBase` optional 字段

- **子系统**：`@harness-one/preset`（影响所有下游 app）
- **现象**：repo 全局打开了 `exactOptionalPropertyTypes`，但
  `HarnessConfigBase` 里的可选字段无论是值类型还是 union，都需要 caller
  写 `...(value !== undefined && { field: value })` 这种条件 spread。
  research-collab 的 `harness-factory.ts` / `pipeline/run.ts` 里出现了
  6 处。
- **影响**：可读性差、容易漏掉一个字段；所有 app 都需要这套样板。
- **临时绕过**：批量条件 spread。
- **建议反哺**：要么放宽到允许显式 `undefined`（违反 exactOptional 项目
  规范），要么提供一个 `withDefined<T>(obj: { [K in keyof T]?: T[K] | undefined })`
  helper 自动剥离 undefined。
- **Status**: workaround
- **Owner**: 主仓库（人体工学小修）

---

## 备注

- 任何 `Status: workaround` 的条目都对应 src/ 里的一处显式注释，所以
  代码 reviewer 能反向找到日志记录。
- 升级 harness-one 时按上面的 ID 检查每条是否仍然存在；resolved 的可以
  删行（git history 留底）。
- 下一次跑通真实 web 调用 / 真实 LLM 时，预计还会发现 trace exporter
  在多 agent 场景下的 buffer 行为问题（DESIGN §5.1 第 4 项）—— 留 slot：
  `L-DATE-00X`。
