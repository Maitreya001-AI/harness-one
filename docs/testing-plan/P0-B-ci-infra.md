# Track B · CI 工程基础（P0）

**预估工时**：0.5 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-B -b testing/track-B-ci-infra main
cd ../harness-one-track-B
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-B-ci-infra`）。harness-one 是 pnpm monorepo，CI 已存在于 `.github/workflows/ci.yml`，跑 Node 18/20/22 × Ubuntu/macOS/Windows 矩阵，以及 typecheck + test:coverage + sourcemap 检查。

**任务**：为仓库增加 4 条 CI gate，兑现"零运行时依赖 + 供应链透明"承诺，并把 coverage 对外可见。

### 先跑 survey

```bash
cat .github/workflows/ci.yml
cat package.json | jq '.scripts'
ls packages/core/package.json && jq '.dependencies, .peerDependencies' packages/core/package.json
```

### 任务清单

#### B1 · Zero-runtime-dep enforce
新建 `.github/workflows/zero-dep.yml`，或在 `ci.yml` 加一个 job。
- 扫 `packages/core/package.json` 的 `dependencies` 字段必须为空或不存在
- 扫 `packages/preset/package.json` 的 `dependencies` 字段必须为空或不存在
- 其他 adapter 包（`packages/anthropic` 等）允许有 `peerDependencies` 但不允许有 `dependencies`（除了打包 util 如必要）
- 失败时 CI 红
- 用 `jq` 或一个 10 行的 node 脚本实现（放在 `tools/check-zero-deps.mjs`），不要引入新的 npm 包
- 在 `package.json` 加 `"check:zero-deps": "node tools/check-zero-deps.mjs"`，CI 调用这个 script

#### B2 · Coverage 对外可见
现状：`pnpm test:coverage` 已能产出 coverage。
- 加 `codecov` 或 `coveralls` action（选 codecov，token 用 GitHub OIDC、无需 secret）
- 在 `ci.yml` test job 后追加上传 step
- 在 `README.md` 顶部 badge 区加 `[![codecov](https://codecov.io/...)]`
- **如果 README 改动超过 badge 行本身，停手**——让 owner 手动加，只改 README 顶部 3 行内的 badge 区
- 另加一个本地查看用的 `pnpm coverage:html` script（如不存在）

#### B3 · pnpm audit CI gate
新建 `.github/workflows/audit.yml` 或 `ci.yml` 加 job：
- `pnpm audit --audit-level=high --prod` 失败即红
- 每周 scheduled 跑一次 + PR 跑一次
- 容忍策略：高危以下放过，高危/严重挂 CI

#### B4 · Bundle size 占位
- 先不引入 `size-limit`（Track L 会做）
- **本 track 只做 B1/B2/B3**，B4 占位说明：确认 Track L 会负责 size-limit，本 track 只在 `README.md` 里预留 badge 占位空行（若尚无）

### File Ownership

- `.github/workflows/zero-dep.yml`（新建，可选）或 `.github/workflows/ci.yml`（修改，加 job）
- `.github/workflows/audit.yml`（新建）或 `ci.yml`（修改）
- `tools/check-zero-deps.mjs`（新建）
- `package.json`（root，仅加 scripts）
- `README.md`（仅 badge 行）

**不要碰**：源代码、测试、`docs/`、`packages/*/src/**`、`packages/*/package.json`。

### DoD / 验收

- [ ] `pnpm check:zero-deps` 在本地通过（现状应为 pass，若 fail 说明发现真问题，写到 PR 描述里 flag 给 owner）
- [ ] `.github/workflows/` 中 yml 能通过 `actionlint` 或至少 `yq` parse
- [ ] codecov badge 在 README 顶部可见（token 部分占位，加 TODO 注释）
- [ ] `pnpm audit --audit-level=high --prod` 本地运行不抛 high/critical（若抛，PR 描述里 flag）
- [ ] 现有 CI job 不变，只做新增

### 纪律

1. 不要升级任何依赖（升级留给 dependabot）
2. 不要引入新的 npm 包到 CI 脚本里
3. 不要改 Node 版本矩阵、不要改现有 test/typecheck/build step
4. 不要改 `docs/architecture/`（本 track 不涉及架构）
5. Commit 粒度：每个 B1/B2/B3 一个 commit

## ---PROMPT END---
