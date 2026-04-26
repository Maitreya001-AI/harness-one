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
