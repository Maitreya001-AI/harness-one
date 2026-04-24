# Track G · Dogfood agent（P0，持续）

**预估工时**：首次搭建 2-3 天，之后持续运行  **依赖**：harness-one 可用（已满足）

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-G -b testing/track-G-dogfood main
cd ../harness-one-track-G
pnpm install --frozen-lockfile
claude
```

> Note: dogfood agent 的**代码**最终可能独立成一个 repo（推荐），但"起步脚手架 + showcase examples"先落在本仓的 `examples/dogfood/` 或 `apps/dogfood/` 里做可见度。独立 repo 的决策在本 track 末尾由 owner 拍板。

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-G-dogfood`）。harness-one 是 TypeScript agent infra 库，要想证明"代码值得信任"，唯一办法是**自己每天在用**。

**任务**：搭一个 dogfood agent 的起步脚手架，让 owner 能立刻跑起来、持续使用、暴露真实问题。

### 先读

```bash
cat README.md | head -80
ls examples/
cat examples/quickstart.ts
cat examples/full-stack-demo.ts 2>/dev/null | head -60
ls packages/preset/src/ 2>/dev/null
```

### 选题（前 30 分钟决策，不要纠结）

三选一（按落地容易度排序）：

1. **Issue triage bot**（推荐）
   - 输入：GitHub 新 issue body
   - 输出：建议 labels、怀疑的复现步骤、关联历史 issue
   - 价值：每天运行 = 持续暴露 adapter、RAG、guardrail 问题
   - 部署：GitHub Action，`issues: opened` 触发

2. **Codebase Q&A agent**
   - 输入：自然语言问题
   - RAG 索引 harness-one 自己的源码 + docs
   - 输出：带 file:line 引用的回答
   - 部署：CLI（`pnpm ask "how does guardrail pipeline work?"`）

3. **Autoresearch loop**（Ralph Loop 风格）
   - 输入：一个主题
   - 循环：search → read → refine → 直到 confidence 阈值
   - 输出：带引用的 markdown report
   - 部署：每周定时跑 1 次，产物入 `dogfood-reports/` 目录

**选一个**，其余写成 `docs/dogfood/roadmap.md` 留给以后。

### 脚手架位置

新建 `apps/dogfood-<选题>/`（pnpm workspace 已涵盖 `apps/*` 吗？如无，加到 `pnpm-workspace.yaml`）。

结构：

```
apps/dogfood-issue-triage/       # 或 -codebase-qa / -autoresearch
  package.json                   # private: true
  src/
    main.ts
    harness-config.ts            # 用 createSecurePreset + real adapter
    tools/                       # 2-3 个 tool 实现
    prompts/
  tests/
    smoke.test.ts                # 起码能 run 一次不崩
  README.md                      # 怎么跑、怎么看日志
```

### 必做约束

1. **用 `createSecurePreset`** 而非手搓 config——这是 dogfood 的意义之一
2. **开启 trace + cost tracker**，每次 run 日志落到 `apps/dogfood-*/logs/YYYY-MM-DD.jsonl`
3. **guardrail 全开 fail-closed**
4. **加一个 "daily summary" script**（`pnpm --filter dogfood-* summary`），扫 logs 输出：
   - 成功 / 失败次数
   - cost 总和
   - 每个失败的 error classification
   - p50/p99 latency

### GitHub Action 集成（如选 option 1）

`.github/workflows/dogfood-triage.yml`：
- `on: issues: opened`
- 跑 `pnpm --filter dogfood-issue-triage run triage -- --issue-number=${{ github.event.issue.number }}`
- 输出 comment 到 issue（标注 "🤖 triage from dogfood agent"）
- 用 `${{ secrets.ANTHROPIC_API_KEY_CI }}` 或 openai secret
- 预算保护：cost tracker 单次 > $0.50 直接 abort 并 comment "budget exceeded"

### File Ownership

- `apps/dogfood-*/**`（新建整个）
- `pnpm-workspace.yaml`（可能修改，加 `apps/*`）
- `.github/workflows/dogfood-triage.yml`（新建，若选 option 1）
- `docs/dogfood/README.md`（新建，说明目的 + 3 选 1 决策记录 + 未选的另外 2 个 roadmap）

**不要碰**：harness-one 源码（`packages/*/src/**`）、`docs/architecture/`、其他 Track 路径。

### DoD / 验收

- [ ] 选题决策写在 `docs/dogfood/README.md`（含未选的 2 个 roadmap）
- [ ] 起码能本地跑一次 smoke：`pnpm --filter dogfood-* smoke` 不崩
- [ ] `pnpm --filter dogfood-* summary` 能产出聚合报告（哪怕只有 1 次 run）
- [ ] `createSecurePreset` + 全 guardrail + trace + cost 都启用
- [ ] 日志写入 `logs/*.jsonl`（不入 git，gitignore 加规则）
- [ ] 若选 GitHub Action 路径，workflow yml 通过 `actionlint`
- [ ] 预算保护生效（本地 mock 一次触发 abort）
- [ ] Owner 文档：怎么跑、怎么看 log、怎么判断出了问题

### 纪律

1. dogfood 是 harness-one 的**消费者**，**不要反向改 harness-one 源码**（发现 bug → 开 issue）
2. 不引入新的 harness-one 依赖到 `packages/*`
3. `apps/dogfood-*` 不入 npm 发布流程（`private: true`）
4. 不改 `docs/architecture/`
5. 先 push branch，PR 由 owner 开（涉及 secret 配置）

### 持续纪律（本 track 不是"完成即结束"）

在 PR 描述里列后续 ritual：
- 每周看一次 `summary` 输出
- 每周挑一个失败 run 写成 bug report（指向 harness-one 的 issue tracker）
- 2 周后评估是否值得独立 repo

## ---PROMPT END---
