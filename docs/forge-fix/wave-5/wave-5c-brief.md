# Wave-5C · 包边界 + API Surface for 1.0-rc

**状态**: pending · **依赖**: Wave-5B 合入 · **估时**: 2-3 周（**需 PRD + ADR**）

## 目标

为 1.0-rc 收紧 API 表面：god-package 拆分、`_internal/` → `infra/` 重命名、
根 barrel 收窄到 ~25 符号、JSDoc stability tag + api-extractor CI gate、
`HarnessErrorCode` 按模块前缀封闭化、删 `eventBus` dead-stub、doc drift CI。

## 范围（Findings）

- **C-2** 根 barrel ~90 符号（三层入口重复：essentials/index/子路径）
- **C-3** `_internal/` 被 16+ 处外部导入，事实上是基础设施层
- **M-3** `HarnessErrorCode` 分裂（21 声明 vs 40+ 实际 throw）
- **M-11** `cli/templates.ts` 651 行字符串常量 god-module
- **ARCH-1** `core` 是 god-package（19,842 LOC，一 npm 包 + 14 subpath exports）
- **ARCH-2** `cli/` + `evolve/` 不该在 runtime core
- **ARCH-3** `@harness-one/ajv` + `@harness-one/tiktoken` 各单文件独立发包
- **ARCH-4** 无 stability 标签（`@experimental/@alpha/@beta/@stable` 全库仅 8 处）
- **ARCH-10** 文档漂移 + `eventBus` dead-stub runtime trap

## 决策（已在 Wave-5 决策文档定）

- **1.0-rc 质量** — 接受所有 breaking changes
- **多租户 in-scope**（影响 5E 不在本 wave）

## 流程（完整 spec-kit）

1. **PRD**（`product-advocate`）→ `technical-skeptic` 挑战 → 锁定需求
   - 关键决策：`@harness-one/cli` vs 保留 subpath？`@harness-one/devkit` 剥离 eval/evolve/architecture-checker？
2. **3 方案竞争**（3× `solution-architect`）→ `technical-critic` 挑战 → `design-arbiter` 裁决
3. **ADR**（锁定）：
   - 包拆分策略（`@harness-one/cli`、`@harness-one/devkit`、合并 ajv+tiktoken？）
   - 根 barrel 收窄到哪 ~25 符号
   - `_internal/` → `infra/` ESLint 边界规则
   - `HarnessErrorCode` 封闭化 namespace 前缀方案
   - api-extractor 配置 + CI gate
4. **`task-planner`** + **`risk-assessor`**
5. **`team-implementer`×6 并行**（包拆分互不冲突）
6. 全套审查（`code-reviewer` + `security-reviewer` + `red-team-attacker` + `spec-reviewer`）→ `review-synthesizer`
7. `acceptance-reviewer`（需求 + 技术视角交叉验收）
8. `doc-updater`

## 需要你拍板的事

- `@harness-one/cli` 独立发布：**npm 账号谁管**？
- 发版节奏：changeset `linked` 锁步 vs 独立版本？
- api-extractor CI gate 失败策略（block merge 还是 warning）？

## 关键文件

- `packages/core/package.json`（subpath exports 收缩）
- `packages/core/src/index.ts`（根 barrel 收窄）
- `packages/core/src/essentials.ts`（可能删除）
- `packages/core/src/_internal/`（→ `infra/`）
- `packages/core/src/cli/` → `packages/cli/`
- `packages/core/src/evolve/` + `eval/` → `packages/devkit/`
- `packages/core/src/core/errors.ts`（`HarnessErrorCode` 封闭化）
- `packages/preset/src/index.ts`（删 `eventBus` dead-stub）
- `.github/workflows/` + 新加 api-extractor job
