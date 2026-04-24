# Track K · Mutation testing（P1）

**预估工时**：3 天  **依赖**：无（依赖已有的单测覆盖）

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-K -b testing/track-K-mutation main
cd ../harness-one-track-K
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-K-mutation`）。harness-one 有 4486+ 个单测，但**真实有效率未知**（行业均值 60-70%）。Mutation testing 回答"我的测试真的有效吗"。

**任务**：给 3 个核心模块接入 Stryker，目标 mutation score ≥ 80%；发现的 surviving mutation 全部补测试（或证明是 equivalent mutant）。

### 先读

```bash
ls packages/core/src/
ls packages/core/src/core/
ls packages/core/src/infra/
ls packages/core/src/guardrails/
cat packages/core/vitest.config.ts
```

### 依赖

在 `packages/core/package.json` 加 `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` 到 devDependencies（pin 最新 stable）。

### 配置

新建 `packages/core/stryker.conf.mjs`：

```js
// 只对 3 个模块跑，不对全仓库跑
export default {
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  mutate: [
    'src/core/**/*.ts',
    'src/infra/validate.ts',
    'src/guardrails/pipeline.ts',
    '!**/*.test.ts',
    '!**/__tests__/**',
  ],
  thresholds: { high: 85, low: 80, break: 80 },  // < 80 fail
  timeoutMS: 60000,
  concurrency: 4,
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: { fileName: '.stryker-tmp/report/index.html' },
};
```

加 scripts 到 `packages/core/package.json`：
- `"mutation": "stryker run"`
- `"mutation:core": "stryker run --mutate 'src/core/**/*.ts'"`
- `"mutation:validate": "stryker run --mutate 'src/infra/validate.ts'"`
- `"mutation:guardrails": "stryker run --mutate 'src/guardrails/pipeline.ts'"`

### 3 个模块依序处理

#### K1 · `src/core/`（agent loop 等）
1. 跑 `pnpm mutation:core`，拿初始 score
2. 看 `.stryker-tmp/report/index.html`，逐个分析 surviving mutant
3. 每个 surviving mutant 要么：
   - **补测试**杀掉它（首选）
   - **标记为 equivalent mutant**（`// Stryker disable next-line ...`，加注释说明为何等价）
4. 目标：mutation score ≥ 80%

#### K2 · `src/infra/validate.ts`
- 同上流程，目标 ≥ 85%（validate 是安全边界，标准高）

#### K3 · `src/guardrails/pipeline.ts`
- 同上流程，目标 ≥ 80%

### CI 集成

- 新建 `.github/workflows/mutation.yml`
- **不在每次 PR 跑**（慢且贵）
- 选一：`schedule: cron '0 3 * * 0'`（每周日跑）+ `workflow_dispatch`（手动触发）
- 产物上传 HTML report 作为 artifact
- break threshold 挂 → 开 issue 而非挂 PR

### 补测试纪律

**surviving mutant = 测试未检测出的 bug 机会**。补测试时：
- 测试名描述 mutant 的具体场景（`it('returns null when limit is exactly equal, not just less-than')`）
- 不要写"模仿 mutant"的测试（如果 mutant 把 `>` 改成 `>=`，测试要抓住边界 `a === b`）
- 若发现是真 bug（mutant 表明代码 wrong 而非 test incomplete），**开 issue 不擅自修**

### File Ownership

- `packages/core/stryker.conf.mjs`（新建）
- `packages/core/package.json`（加 devDeps + scripts）
- `packages/core/.gitignore` 或 root `.gitignore`（加 `.stryker-tmp/`）
- `packages/core/src/**/__tests__/**`（**新增**测试文件；**禁止**修改同目录下既有测试的断言）
- `.github/workflows/mutation.yml`（新建）
- `docs/architecture/17-testing.md`（**必须更新**，新增 mutation 章节 + 当前 score）

**不要碰**：源码（`packages/core/src/**/*.ts` 非 test 文件）——发现 mutant 揭示的真 bug 开 issue 不改。

### DoD / 验收

- [ ] 3 个模块 mutation score ≥ 80%（`src/infra/validate.ts` ≥ 85%）
- [ ] Stryker HTML report 可查看
- [ ] Incremental mode 能工作（第二次跑 < 30s）
- [ ] 至少一次 `break` threshold 实测：手动注释掉一条断言，确认 CI 会红
- [ ] Equivalent mutant 都有 `// Stryker disable` 注释 + 中文/英文说明为何等价
- [ ] Mutation workflow yml 通过 `actionlint`
- [ ] `docs/architecture/17-testing.md` 记录当前 score（作为 baseline）

### 纪律

1. **只在 3 个模块跑**，不要扩到全仓库
2. 不改源码（除非 mutant 揭示了真 bug 且经 owner 同意）
3. 发现的真 bug → 开 issue，不在本 PR 修
4. 改测试层架构，更新 `docs/architecture/`
5. Commit 粒度：配置 + 依赖一个 commit、每个模块补测一个 commit、CI workflow 一个 commit

## ---PROMPT END---
