# Track E · Examples + README 入 CI（P0）

**预估工时**：0.5 天  **依赖**：无（cassette execute 模式可后置到 Track C 完成后）

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-E -b testing/track-E-examples-ci main
cd ../harness-one-track-E
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-E-examples-ci`）。`examples/` 目录下有 ~25 个示例文件，`README.md` 含大量 `ts` 代码块。用户第一印象就是 examples，examples 编译挂或运行挂是最尴尬的 bug。

**任务**：让 examples 和 README 代码块在 CI 里被验证。

### 先跑 survey

```bash
ls examples/
cat examples/quickstart.ts | head -40
jq '.scripts' package.json
jq '.scripts' examples/package.json 2>/dev/null
grep -n "typecheck" .github/workflows/ci.yml
```

注意 CI 里 `pnpm typecheck` 已经覆盖 examples/（见 `ci.yml` 的注释）。**本 track 要做的是增量**：

1. Examples 在 CI 真正 **execute**（用 mock/cassette adapter）
2. README 的 ` ```ts ` 块 extract 出来跑 `tsc --noEmit`

### 任务清单

#### E1 · Examples typecheck gate（可能已 cover，验证一下）
- 确认 `pnpm typecheck` 真的会 cover `examples/**/*.ts`
- 若未 cover，补一个 `examples/tsconfig.json` 或在 root tsconfig include
- **不需要新建 CI job**，现有 typecheck 应该足够

#### E2 · Examples smoke execute
- 新建 `tools/run-examples.mjs`：扫 `examples/*.ts`（顶层 + 子目录），用 `tsx` execute 每一个
- 每个 example 必须接受 mock adapter 路径注入（检查现有 examples 是否已支持；若没有，**不要改** examples，在 script 里用 `process.env.HARNESS_MOCK=1` 做条件跳过并打印 `SKIP: example X needs real adapter`）
- Pass 标准：execute 不抛未捕获异常、不 hang > 10s
- 加 `pnpm examples:smoke` script
- 在 `ci.yml` 加 job `examples-smoke`，只跑 Ubuntu + Node 20（不用全矩阵）
- 如果 Track C 的 cassette infra 已合并（grep `packages/core/src/testing/cassette`），优先用 cassette adapter 替代 mock；否则用 `createMockAdapter` from `harness-one/testing`

#### E3 · README 代码块 extract + typecheck
- 新建 `tools/check-readme-snippets.mjs`：用 `remark` + `remark-frontmatter` 或纯正则扫 `README.md` 所有 ` ```ts ` / ` ```typescript ` 块
- 每个 snippet 写到 `/tmp/readme-snippets/*.ts`
- 跑 `tsc --noEmit` 对 `/tmp/readme-snippets/`
- 允许 snippet 里 `import from 'harness-one'`（解析到本地 `packages/core`）
- 加 `pnpm check:readme` script
- 在 `ci.yml` 加 step（可和 B track 的 job 合并到一个 `quality` job 里，或独立）

**如果 README 里大量 snippet 无法独立 typecheck**（例：用到未定义的外部变量），允许在 snippet 外加 `<!-- noverify -->` HTML 注释跳过，但要在 script 里统计跳过比例，超过 30% 则 CI 红（强制 README 可执行率）。

### File Ownership

- `tools/run-examples.mjs`（新建）
- `tools/check-readme-snippets.mjs`（新建）
- `package.json`（root，仅加 scripts）
- `.github/workflows/ci.yml`（加 step/job）
- `examples/tsconfig.json`（可能新建，仅当现有未 cover）

**不要碰**：`examples/*.ts` 内容、`README.md` 内容（除非加 `<!-- noverify -->`）、源代码、`docs/`。

### DoD / 验收

- [ ] `pnpm typecheck` 已 cover examples（本地 + CI）
- [ ] `pnpm examples:smoke` 在本地 execute 全部 example，0 unhandled error
- [ ] `pnpm check:readme` 在本地 extract 并 typecheck README 所有 ts snippet（或明确跳过比例 < 30%）
- [ ] CI 新 job 跑通一次（可 push 到 branch 触发）
- [ ] 若发现 example / snippet 的真实 bug，**修 example 内容**（允许），commit 粒度拆开
- [ ] 若 Track C cassette infra 未 ready，E2 用 mock adapter，在 PR 描述里标 "TODO: swap mock for cassette when Track C lands"

### 纪律

1. 不要改 harness-one 源代码
2. 不要改 README 正文（只能加跳过注释）
3. 不要引入重量级运行时（允许 `tsx`、`remark` 作为 devDependency 加到 root）
4. 不要和 Track C 耦合；cassette integration 只做 feature-flagged 接入
5. 本 track 不涉及架构，不需改 `docs/architecture/`

## ---PROMPT END---
