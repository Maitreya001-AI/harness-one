# Track A · 社区治理（P0）

**预估工时**：0.5 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-A -b testing/track-A-community main
cd ../harness-one-track-A
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-A-community`）。harness-one 是一个准备开源发布的 TypeScript agent infra 库，本仓库是 pnpm monorepo，packages 在 `packages/*`。

**任务**：补齐社区治理卫生（企业 procurement 强制勾选项 + OSSF Best Practices 门槛）。

### 先跑 survey（必做第一步）

```bash
ls -la LICENSE CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md CODEOWNERS .github/ISSUE_TEMPLATE/ .github/PULL_REQUEST_TEMPLATE.md 2>&1
cat CONTRIBUTING.md | head -100
```

根据结果决定每项是新建还是补强；**已存在的文件不要重写**，只做增量修订并在 commit message 中说明原因。

### 任务清单

1. **`CODE_OF_CONDUCT.md`**（root）
   - 采用 [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) 原文
   - 替换 `[INSERT CONTACT METHOD]` 为项目邮箱（先占位 `conduct@harness-one.dev`，在文件里加 TODO 注释让 owner 替换）

2. **`SECURITY.md`**（root）
   - 覆盖：Supported Versions 表（最新两个 minor）、Reporting a Vulnerability（推荐 GitHub Security Advisory，备用邮箱同上占位）、Response SLA（7 天 ack、30 天修复或 mitigation）、Safe Harbor 声明
   - 长度控制在 60 行内

3. **`CODEOWNERS`**（root 或 `.github/CODEOWNERS`）
   - 按现有 `packages/*` 列一遍，owner 先统一占位 `@XRenSiu`
   - 添加 `/docs/architecture/ @XRenSiu`、`/packages/core/src/core/ @XRenSiu` 等关键路径

4. **`.github/ISSUE_TEMPLATE/bug_report.yml`**
   - 使用 GitHub Issue Form（yml），必填字段：harness-one version、Node version、最小复现（repo URL 或 code block）、预期 vs 实际、日志/trace
   - 添加 `.github/ISSUE_TEMPLATE/feature_request.yml`（轻量）
   - `.github/ISSUE_TEMPLATE/config.yml` 关闭 blank issues、链到 Discussions

5. **`.github/PULL_REQUEST_TEMPLATE.md`**
   - Checklist: 关联 issue、测试已加 / 已更新、`docs/architecture/` 已同步（若改动 core/infra/guardrails/observe）、Changeset 已加（若涉及 public API）

6. **`CONTRIBUTING.md` review**
   - 读现有文件，补：（a）开发环境 setup（Node 版本、pnpm 版本、`pnpm install && pnpm build && pnpm test`）、（b）测试规范（引用 `docs/testing-plan.md`）、（c）Changeset 流程、（d）commit message 风格

### File Ownership（只能改这些路径）

- `CODE_OF_CONDUCT.md`（新建）
- `SECURITY.md`（新建）
- `CODEOWNERS` 或 `.github/CODEOWNERS`（新建）
- `.github/ISSUE_TEMPLATE/**`（新建）
- `.github/PULL_REQUEST_TEMPLATE.md`（新建）
- `CONTRIBUTING.md`（仅修订）

**不要碰**：源代码、测试、`docs/architecture/`、`docs/testing-plan.md`、其他 Track 路径。

### DoD / 验收

- [ ] 所有 6 个交付物落地（或已存在且经过 review）
- [ ] `.github/ISSUE_TEMPLATE/bug_report.yml` 在 GitHub UI 能正常渲染（yml 格式合法）
- [ ] SECURITY.md 的邮箱/渠道占位清晰标注 TODO
- [ ] CODEOWNERS 用 `git check-attr` 或在 GitHub PR preview 中能匹配到 owner
- [ ] `pnpm lint` 通过（不会改代码，但跑一下防止格式检查误伤 md）

### 纪律

1. 不要新增任何运行时依赖
2. 不要修改源代码、测试、CI workflow
3. 不要改 `docs/architecture/`
4. Commit 粒度：每个交付物一个 commit，祈使句开头
5. 完成后 `git push origin testing/track-A-community`，不开 PR（由人决定合并时机）

## ---PROMPT END---
