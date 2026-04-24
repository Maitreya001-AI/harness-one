# Track M · 安全供应链 + 文档 CI（P1）

**预估工时**：3 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-M -b testing/track-M-security-docs main
cd ../harness-one-track-M
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-M-security-docs`）。

**任务**：接入 OpenSSF Scorecard + Best Practices、secret scan、SBOM、typedoc + 链接检查，让仓库通过企业 procurement 的"供应链透明 + 文档可信"门槛。

### 先读

```bash
ls .github/workflows/
cat .github/workflows/ci.yml | head
cat package.json | jq '.scripts'
ls docs/ | head
grep -r "typedoc" package.json packages/*/package.json 2>/dev/null
```

### 任务清单

#### M1 · OpenSSF Scorecard workflow
- `.github/workflows/scorecard.yml`
- 基于官方模板 `ossf/scorecard-action`
- `permissions: security-events: write, id-token: write, contents: read`
- `schedule: cron '0 5 * * 1'` + push on main
- 上传 SARIF 到 GitHub code scanning
- README 加 badge（`https://api.securityscorecards.dev/projects/github.com/<org>/harness-one/badge`，占位 org/owner）

#### M2 · OpenSSF Best Practices 申请
- 新建 `docs/security/ossf-best-practices.md`
- 列出 Passing 级 18 条每条的现状 + 达成方式（已达成的标 ✅，待达成的写行动项）
- 在 README 加申请链接占位 `[![OpenSSF Best Practices](https://bestpractices.coreinfrastructure.org/projects/TODO/badge)](...)`
- 实际申请提交由 owner 操作（本 PR 只准备好材料）

#### M3 · Secret scan CI
- `.github/workflows/secret-scan.yml`
- 用 `gitleaks/gitleaks-action`（或 `trufflesecurity/trufflehog`）
- 全仓 + PR diff
- fail fast on any finding
- 加 `.gitleaks.toml`（从默认模板开始，针对 harness-one 额外 allowlist：`packages/*/tests/cassettes/**` 如果 cassette 里出现看起来像 key 的字符串——但应该早已 scrub；先不 allowlist，让它红一次，真发现问题再说）

#### M4 · SBOM 生成
- `.github/workflows/sbom.yml`
- `on: release` + `workflow_dispatch`
- 用 `cyclonedx/gh-node-module-generatebom` 或 `anchore/sbom-action`
- 产出 `sbom-<version>.json`（CycloneDX JSON 格式），upload 为 release asset
- 一并跑 `npm audit --json` 输出到 `audit-<version>.json` 作附件

#### M5 · `typedoc` 生成 + CI gate
- 在 root 或各 package 加 `typedoc` devDep
- 新建 `typedoc.json`（root 或 per-package）:
  ```json
  {
    "entryPoints": ["packages/core/src/index.ts", "packages/preset/src/index.ts", ...],
    "out": ".typedoc",
    "excludePrivate": true,
    "validation": { "invalidLink": true, "notExported": true }
  }
  ```
- 加 `"docs:api": "typedoc"` script
- CI 加 step `pnpm docs:api`，失败（无效链接、未导出引用）即 CI 红
- 不 publish 产物（只做 gate）；如果 owner 想做 GitHub Pages 发布，在本 PR 描述里提议 M5.5 后续跟进

#### M6 · Broken link checker
- 用 `lychee-action/lychee-action`
- `.github/workflows/docs-links.yml`
- 扫 `docs/**/*.md`、root `*.md`
- 配 `lychee.toml`（exclude `example.com`、localhost、github.com/repo-path 等已知）
- `schedule: cron` + PR

#### M7 · Redact 对抗性测试
- 新建 `packages/core/tests/security/redact-adversarial.test.ts`
- 构造多种 API key / token / secret 格式：
  - `sk-ant-` 前缀
  - `sk-` OpenAI
  - AWS `AKIA...`、`ASIA...`
  - GitHub `ghp_...`、`gho_...`、`ghs_...`
  - JWT pattern `eyJ...`
  - PEM block
  - 嵌入在 URL 里 (`https://...?api_key=...`)
  - 嵌入在 JSON 里 (`{"Authorization": "Bearer ..."}`)
  - 中文 / utf-8 噪声夹杂
  - 部分截断、跨行
- 对每种格式过 redact pipeline，断言 100% 被 mask
- 每一类失败信号 = 一条 issue（不在本 PR 修）

### File Ownership

- `.github/workflows/{scorecard,secret-scan,sbom,docs-links}.yml`（新建）
- `.gitleaks.toml`（新建）
- `lychee.toml`（新建）
- `typedoc.json`（新建，root）
- `docs/security/ossf-best-practices.md`（新建）
- `packages/core/tests/security/redact-adversarial.test.ts`（新建）
- `package.json`（root，加 scripts + typedoc devDep）
- `README.md`（仅顶部 badge 区）

**不要碰**：源码、其他 Track 路径、现有 docs 文件。

### DoD / 验收

- [ ] 4 个新 workflow yml 通过 `actionlint`
- [ ] `pnpm docs:api` 本地能生成（即使有警告也要 fail on invalid link）
- [ ] `lychee docs/` 本地能跑
- [ ] Redact 对抗性测试至少 15 种 pattern，全绿
- [ ] Scorecard badge + OSSF Best Practices 占位 badge 出现在 README
- [ ] SBOM workflow dispatch 手动触发能产出 json（owner 验证）
- [ ] `docs/security/ossf-best-practices.md` 逐条列 Passing 18 条状态
- [ ] **本 track 不改源码**，redact 测试发现的真问题开 issue

### 纪律

1. 不引入新运行时依赖（typedoc、lychee、gitleaks 都是 devDeps / CI-only）
2. 不修复 redact 发现的真 bug（开 issue 让 owner 排期）
3. README 改动范围严格限制在 badge 行
4. 不改 `docs/architecture/`（本 track 是运营层而非架构层）
5. Commit 粒度：M1/M2/M3/M4/M5/M6/M7 各独立 commit

## ---PROMPT END---
