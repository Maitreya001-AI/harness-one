# Track P · Release 工程 + 跨版本 compat（P2）

**预估工时**：5 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-P -b testing/track-P-release main
cd ../harness-one-track-P
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-P-release`）。开源专业度最后 1%，也是企业 procurement 审计的标配。

**任务**：让 release 产物可复现、可追溯、可验证；并为跨版本演化加可执行断言。

### 先读

```bash
ls .changeset/
cat .changeset/config.json 2>/dev/null
cat package.json | jq '.scripts, .packageManager'
ls packages/*/package.json | head
cat MIGRATION.md | head -80
grep -rn "prepublishOnly\|publish" packages/*/package.json | head
```

### 任务清单

#### P1 · `pnpm pack` 确定性
- 新建 `tools/check-pack-reproducible.mjs`
- 对 `packages/core` 跑两次 `pnpm pack`，sha256 hash 必须一致
- 常见破坏确定性的因素：mtime、package order in tarball、env-dependent fields
- 用 `SOURCE_DATE_EPOCH=<固定值> pnpm pack --pack-destination /tmp/pack-A`、`.../pack-B` 然后 diff
- 加 `pnpm check:pack` script
- CI workflow `.github/workflows/release-pack.yml`：在 PR 里跑

#### P2 · SLSA Provenance
- `.github/workflows/release.yml`（若不存在则新建；若已由 changesets 管，加 job）
- `on: release: published`
- 用 `actions/attest-build-provenance@v1` + `actions/attest@v1`
- 每个 npm package tarball 生成 attestation，附到 release

#### P3 · npm OIDC trusted publishing
- 在 `.github/workflows/release.yml` 的 publish job 用 `permissions: id-token: write`
- 移除任何 `NPM_TOKEN` secret 依赖（改用 OIDC）
- 在 `docs/release.md` 写清"如何在 npm 上配置 trusted publisher（packages → settings → trusted publisher → Add GitHub workflow）"
- **本 PR 只改 workflow**，npm 侧配置由 owner 在 npm UI 操作

#### P4 · Release 签名（`npm provenance` / Sigstore）
- Publish 时加 `--provenance`
- `packages/*/package.json` 的 publishConfig 加 `"provenance": true`
- 文档说明用户如何验证：`npm audit signatures` + `sigstore verify`

#### P5 · API compat matrix
- `.github/workflows/compat-matrix.yml`
- Matrix 跑：
  - `core@latest + anthropic@previous`
  - `core@previous + anthropic@latest`
  - 至少覆盖最近 2 个 minor version
- 方法：checkout main → 在临时目录用 npm pack 出 "previous" 版本（或从 npm registry 拉）→ 组合安装到测试 fixture → 跑 smoke scenarios
- 失败即红（peer dep 真实可用性的唯一证据）
- **如果 peer dep 约束本身缺失**（`adapter` 未声明 `peerDependencies`），本 PR 不要擅自加，开 issue

#### P6 · Migration path 可执行化
- `MIGRATION.md` 里每条 migration 写成 fixture：
  - `tools/migrations/0.1-to-0.2/pre/` 一段 pre-migration 代码
  - `tools/migrations/0.1-to-0.2/post/` 对应 post-migration 代码
  - 一个 script 把 pre 跑一遍（应 fail 或 deprecation warn）、把 post 跑一遍（应 pass）
- 加 `pnpm check:migrations` script
- CI 跑（`.github/workflows/migrations.yml`）
- 若仓库版本还没到 "需要 migration" 阶段，**只做脚手架 + 一个示例 migration fixture**（以 MIGRATION.md 中最早一条为例）

#### P7 · 文档英文化策略（准备层，不翻译）
- 新建 `docs/i18n-strategy.md`：列当前 zh-CN 文档清单 + 英文化优先级
- **不本 PR 做实际翻译**（那是另一个工作量的活）
- 若有明显纯中文的核心文档（如 `docs/ARCHITECTURE.md`），只打 TODO 标记，不翻译
- 建议在 root 加 `README.en.md` 占位软链到 `README.md`（现状 README.md 即英文版，无需新文件；核对一下）

### File Ownership

- `.github/workflows/{release,release-pack,compat-matrix,migrations}.yml`（新建）
- `tools/check-pack-reproducible.mjs`（新建）
- `tools/migrations/**`（新建）
- `package.json`（root，加 scripts）
- `packages/*/package.json`（加 `publishConfig.provenance`）
- `docs/release.md`（新建，说明 OIDC 配置 + 签名验证）
- `docs/i18n-strategy.md`（新建）

**不要碰**：源代码、`.changeset/` 现有配置（除非必须）、其他 Track 路径。

### DoD / 验收

- [ ] `pnpm check:pack` 本地两次 pack 产出 sha256 一致
- [ ] `.github/workflows/release.yml` 在 dry-run 下 lint 通过（用 `actionlint`）
- [ ] `publishConfig.provenance: true` 在所有 publish 的 package 里
- [ ] `docs/release.md` 详述 OIDC trusted publisher 配置步骤（owner 可照着做）
- [ ] compat-matrix workflow 能跑（至少一个组合跑通）
- [ ] `tools/migrations/` 至少一个 pre/post fixture
- [ ] 所有 workflow yml 通过 `actionlint`

### 纪律

1. **不在本 PR 实际 publish**（涉及 secret / npm OIDC 配置，需 owner 在 UI 操作）
2. 不改 `.changeset/config.json` 语义（如需调整，开 issue）
3. 不删任何现有 workflow
4. `docs/architecture/` 本 track 不动（release 流程属 ops 层）
5. 若发现 peer dep 声明问题→开 issue，不擅自修改 `packages/*/package.json` 的 peerDeps
6. Commit 粒度：P1/P2/P3/P4/P5/P6/P7 各一个

## ---PROMPT END---
