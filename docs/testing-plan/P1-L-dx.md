# Track L · DX 测试（P1）

**预估工时**：3 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-L -b testing/track-L-dx main
cd ../harness-one-track-L
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-L-dx`）。开源库的"用户体验"不是 UI，是第一次用的 5 分钟体验。

**任务**：为 4 条 DX 质量承诺加可执行断言。

### 先读

```bash
cat packages/core/package.json | jq '.exports'
grep -rn "class.*HarnessError\|extends HarnessError" packages/core/src --include="*.ts" | head -20
cat eslint.config.js | head -80
ls packages/*/package.json | xargs -I {} sh -c 'echo "--- {} ---"; jq .exports {}' | head -60
```

### 任务清单

#### L1 · Bundle size regression（`size-limit`）

1. 加 `size-limit` + `@size-limit/preset-small-lib` 到 root devDependencies
2. 新建 `.size-limit.json`（root）：
   ```json
   [
     { "path": "packages/core/dist/index.js", "limit": "30 KB", "name": "harness-one/core" },
     { "path": "packages/core/dist/advanced/index.js", "limit": "10 KB", "name": "harness-one/advanced" },
     { "path": "packages/core/dist/testing/index.js", "limit": "15 KB", "name": "harness-one/testing" },
     { "path": "packages/preset/dist/index.js", "limit": "8 KB", "name": "preset" },
     { "path": "packages/anthropic/dist/index.js", "limit": "10 KB", "name": "anthropic adapter" },
     { "path": "packages/openai/dist/index.js", "limit": "10 KB", "name": "openai adapter" }
   ]
   ```
   - **先跑一次测实际尺寸**，把 limit 设成 `ceil(actual * 1.05)`（留 5% 余量，超即 fail）
3. 加 script `"size": "size-limit"`
4. `.github/workflows/ci.yml` 加 step（或独立 workflow `size.yml`），PR 里跑
5. 用 `andresz1/size-limit-action` 把 diff 贴到 PR comment

#### L2 · Tree-shaking 验证

证明用户 `import { createAgentLoop } from 'harness-one'` 时，bundle 里不包含 `rag` / `evolve-check` 等子系统代码。

1. 新建 `tools/tree-shake-check/`
2. 写 fixtures：
   - `fixtures/core-only.ts`：`import { createAgentLoop } from 'harness-one'; console.log(typeof createAgentLoop);`
   - 用 `esbuild --bundle --minify --platform=node` 打成 `out/core-only.js`
3. 断言 output 里 **不包含**：
   - `'indexScoped'`（RAG）
   - `'evolveCheck'`
   - `'createEvaluator'`
   - 自定义一组"不该出现的符号"列表
4. 加一个正向断言：output 包含 `'createAgentLoop'`（sanity check）
5. 加 script `"check:tree-shake": "node tools/tree-shake-check/run.mjs"`
6. CI 加 step

#### L3 · Error message 质量 lint

每个 `HarnessError` 子类必须抛的 message 含 action item。写一条 ESLint custom rule 或一个 AST-based 检查脚本：

1. 新建 `tools/lint-error-messages/check.mjs`
2. 扫 `packages/*/src/**/*.ts` 找所有 `throw new SomeHarnessError(msg, ...)` 调用
3. 断言 `msg` 满足（任一）：
   - 包含动词短语（"Call X", "Pass Y", "Use Z"）
   - 或引用了错误代码文档锚点（`(see: docs/.../errors.md#...)`）
   - 或是显式常量引用（`ERROR_MESSAGES.XXX`）
4. 禁用 pattern：纯描述无 action 的 message（`"Invalid argument"`、`"Not allowed"`）
5. 找到违反即列表打印，非零退出
6. 加 script `"lint:errors": "node tools/lint-error-messages/check.mjs"`
7. 融入 `pnpm lint` 或 CI 独立 step
8. **发现违反先 grep 列清单**，分 batch 修（或在 PR 描述里列给 owner 让他排期，不在本 PR 强改所有）

#### L4 · TSDoc `@example` 强制

每个公开工厂函数（`createXxx`）必须有 `@example`。

1. `tools/lint-tsdoc/check.mjs`：扫每个 package 的 `src/index.ts` 或 public entrypoint
2. 对每个导出的 `createXxx` function/factory，在源定义处查 TSDoc
3. 没有 `@example` 就列出，fail
4. 加 script `"lint:tsdoc": "node tools/lint-tsdoc/check.mjs"`
5. 同上，**先 grep 列清单**——补 `@example` 可能涉及大量 TSDoc 修改，**仅**在公开工厂上严格执行，私有函数不强求
6. 如果 TSDoc 缺失量 > 10 处，在 PR 描述里明确列出，让 owner 分批补而不是堆在本 PR

### File Ownership

- `.size-limit.json`（新建）
- `tools/tree-shake-check/**`（新建）
- `tools/lint-error-messages/**`（新建）
- `tools/lint-tsdoc/**`（新建）
- `package.json`（root，加 scripts + devDeps）
- `.github/workflows/ci.yml`（加 step）或新 workflow

**不要碰**：源码（除非补 `@example` TSDoc，属于 L4 边界内；即便如此，分 batch commit 并在 PR 列表出来）、其他 Track 路径。

### DoD / 验收

- [ ] `pnpm size` 本地输出每个 entry 的 gzip 尺寸 + limit 对比
- [ ] `pnpm check:tree-shake` 本地通过（rag / evolve-check 不在 core bundle 里）
- [ ] `pnpm lint:errors` 输出违反清单（可能非 0，但有清晰列表给 owner）
- [ ] `pnpm lint:tsdoc` 输出缺失清单
- [ ] CI 新 step / job 工作
- [ ] size-limit PR comment 能看到

### 纪律

1. `size-limit` 的 limit 值宁可紧不可松（5% 余量）
2. 如果发现 core bundle 意外膨胀或 tree-shake 泄漏，**不要擅自重构源码**，开 issue flag 给 owner
3. Tree-shake 检查的"黑名单符号"要保守（只列明确不该出现的），避免假阳性
4. 本 track 不动架构，但若 L3 / L4 发现 public API shape 问题，**可能**需要更新 `docs/architecture/`——在 PR 描述里问 owner
5. Commit 粒度：L1/L2/L3/L4 各一个 commit；devDeps 添加独立 commit

## ---PROMPT END---
