# harness-one 测试体系落地计划

> 基于《harness-one 测试体系完整蓝图》的可执行拆分。每个 Track 都是一个可以在独立 worktree 中并行推进的工作流，会话之间不共享文件，避免冲突。

---

## 0. 心智模型

harness-one 要证明三件事：**代码对 / 代码一直对 / 代码值得信任**。蓝图列出 15 层 + 跨版本 + 社区共 17 条维度。本计划把 P0/P1/P2 全部切成 11 条可并行 Track、约 50 个独立任务。

---

## 1. 依赖地图（唯一的 3 处共享基础设施）

除下面这 3 条共享设施外，**所有任务互相独立**，可以分别开 session 同时推进：

```
[INFRA-A] Smoke test 脚本 (半天)
     └─→ [INFRA-B] Cassette 录制/回放 (2 天)
              ├─→ Contract suite 的 cassette 模式
              └─→ Examples CI 的 execute 模式

[INFRA-C] chaos-adapter wrapper (2 天)
     └─→ 所有 Chaos scenarios (P1)

[INFRA-D] createAdapterContractSuite 工厂 (2 天)
     └─→ 每个 adapter 的契约套件
```

INFRA-A/B/C/D 全部落在 `@harness-one/core` 的 `testing/` 子路径下（已存在：`packages/core/src/testing/`），互不耦合。

---

## 2. Track 总览

| Track | 优先级 | 主题 | 依赖 | 预估工时 | Prompt |
|---|---|---|---|---|---|
| **A** | P0 | 社区治理（SECURITY / CoC / CODEOWNERS / Templates） | 无 | 0.5 天 | [testing-plan/P0-A-community.md](./testing-plan/P0-A-community.md) |
| **B** | P0 | CI 工程基础（zero-dep / coverage badge / audit） | 无 | 0.5 天 | [testing-plan/P0-B-ci-infra.md](./testing-plan/P0-B-ci-infra.md) |
| **C** | P0 | 契约 suite + Cassette（INFRA-A/B/D） | 真实 API key | 7 天 | [testing-plan/P0-C-contract-cassette.md](./testing-plan/P0-C-contract-cassette.md) |
| **D** | P0 | 5-8 个跨子系统集成 scenario | 无 | 5 天 | [testing-plan/P0-D-integration.md](./testing-plan/P0-D-integration.md) |
| **E** | P0 | Examples + README 入 CI | 可选 INFRA-B | 0.5 天 | [testing-plan/P0-E-examples-ci.md](./testing-plan/P0-E-examples-ci.md) |
| **F** | P0 | 5-10 条 ADR | 无 | 0.5 天 | [testing-plan/P0-F-adr.md](./testing-plan/P0-F-adr.md) |
| **G** | P0 | Dogfood agent（持续运行） | harness-one 可用 | 持续 | [testing-plan/P0-G-dogfood.md](./testing-plan/P0-G-dogfood.md) |
| **H** | P1 | Chaos（INFRA-C + 5 scenarios） | 无 | 7 天 | [testing-plan/P1-H-chaos.md](./testing-plan/P1-H-chaos.md) |
| **I** | P1 | Perf baseline 5 条 + ±15% 漂移 gate | 无 | 5 天 | [testing-plan/P1-I-perf.md](./testing-plan/P1-I-perf.md) |
| **J** | P1 | Property-based 8 条 | 无 | 5 天 | [testing-plan/P1-J-pbt.md](./testing-plan/P1-J-pbt.md) |
| **K** | P1 | Mutation testing（3 个核心模块） | 无 | 3 天 | [testing-plan/P1-K-mutation.md](./testing-plan/P1-K-mutation.md) |
| **L** | P1 | DX 测试（size-limit / tree-shake / errmsg lint） | 无 | 3 天 | [testing-plan/P1-L-dx.md](./testing-plan/P1-L-dx.md) |
| **M** | P1 | 安全供应链 + 文档 CI | 无 | 3 天 | [testing-plan/P1-M-security-docs.md](./testing-plan/P1-M-security-docs.md) |
| **N** | P2 | 类型级测试 | 无 | 3 天 | [testing-plan/P2-N-type-level.md](./testing-plan/P2-N-type-level.md) |
| **O** | P2 | Fuzz + STRIDE 威胁模型 | 无 | 5 天 | [testing-plan/P2-O-fuzz-threat.md](./testing-plan/P2-O-fuzz-threat.md) |
| **P** | P2 | Release 工程 + 跨版本 compat | 无 | 5 天 | [testing-plan/P2-P-release.md](./testing-plan/P2-P-release.md) |

---

## 3. 建议启动顺序

```
Day 1 立刻开（0 依赖，10 条 track 齐飞）：
  A, B, D, E, F, G, I, J, K, L, M, N, O, P
Day 1 串行基础设施：
  C（INFRA-A → INFRA-B → INFRA-D），H（INFRA-C）
Day 3–4 基础设施 ready 后解除封锁：
  H 的 5 个 scenarios / C 的 contract 套件 / E 的 execute 模式
```

Solo maintainer 建议按 P0 顺序串行推进：**D → C → E → G → A/B/F → P1**。

---

## 4. 如何开一个 Track session

### 4.1 通用 worktree 设置

```bash
# 从主仓 root 开始
cd /Users/xrensiu/development/owner/harness-one

# 为 Track X 创建独立 worktree（目录在仓库同级，避免污染主仓）
git worktree add ../harness-one-track-X -b testing/track-X main
cd ../harness-one-track-X

# 安装依赖（worktree 是独立 FS，需要重装）
pnpm install --frozen-lockfile
```

> Track 命名：`testing/track-A-community`、`testing/track-D-integration` 等，保持一致。

### 4.2 启动 session

1. 在新 worktree 目录下 `claude`
2. 打开对应 `docs/testing-plan/P0-A-community.md` 等文件
3. **完整复制"Prompt"章节（`---PROMPT START---` 到 `---PROMPT END---`）** 作为新 session 的第一条消息
4. 每个 prompt 都是自包含的，无需额外上下文

### 4.3 完成后清理

```bash
# 在主仓目录
cd /Users/xrensiu/development/owner/harness-one

# 推 branch（或 PR）
git push origin testing/track-X

# 删除 worktree（保留 branch）
git worktree remove ../harness-one-track-X
```

---

## 5. 跨 Track 纪律（所有 session 共享）

每个 prompt 里都会复述一遍，汇总在此：

1. **文件所有权**：每个 Track 只能碰自己声明的目录/文件，列在各自 prompt 的"File Ownership"章节。不要动别的 track 的文件。
2. **架构变更同步**：如果改动涉及 `packages/core/src/core/`、`packages/core/src/infra/`、`packages/core/src/guardrails/`、`packages/core/src/observe/` 等核心目录，**必须同步更新 `docs/architecture/` 下对应文档**。
3. **零运行时依赖承诺**：`@harness-one/core` 的 `dependencies` 字段必须保持空。新的 devDependency 只加在需要的 package 里。
4. **Vitest 覆盖率门槛**：每个 package 已配 lines/functions/statements=80、branches=75，**不允许下降**。
5. **Flaky 零容忍**：测试挂了修到底，绝不 retry / skip 绕过。
6. **Commit 信号**：commit message 用祈使句开头（"Add ...", "Introduce ..."），保持与 `git log` 风格一致。
7. **PR 一 track 一 PR**：每个 Track 最终一个 PR（可以多 commit），方便 review。

---

## 6. 现状对齐（已完成项，不要重复做）

| 蓝图中提到的项 | 仓库现状 |
|---|---|
| LICENSE | ✅ 已有（root `LICENSE`） |
| CONTRIBUTING.md | ✅ 已有（root `CONTRIBUTING.md`，Track A 可 review 补强） |
| Node 18/20/22 matrix | ✅ `.github/workflows/ci.yml` 已配（Ubuntu/macOS/Windows × Node 18/20/22） |
| 覆盖率门槛 | ✅ Vitest lines/functions/statements=80、branches=75 |
| `@harness-one/core` 零运行时依赖 | ✅ 已落实（CI 需加 enforce，属 Track B） |
| `harness-one/testing` 子路径 | ✅ 已存在于 `packages/core/src/testing/`，INFRA-A/B/C/D 都落在这里 |
| MIGRATION.md | ✅ 已有（Track P 的 migration 可执行化依赖它） |
| Changesets | ✅ `.changeset/` 已配 |
| API-extractor | ✅ `api-extractor.base.json` 已配 |
| dependabot | ✅ `.github/dependabot.yml` 已配 |

Track prompt 里会提示 session 自己 grep 验证，不依赖这张表的时效性。

---

## 7. 验收终线（6 条同时达成 = 站得住脚）

1. 一次真实 Anthropic + OpenAI smoke test 亲手跑通（Track C / G）
2. P0 全做完（A-G）
3. ≥ 4 个差异化 showcase agent 能真实跑（Track G）
4. 你自己每天用 harness-one 搭的工具 dogfood ≥ 2 周（Track G）
5. 非你本人的 TS 开发者从零跑通 quickstart（Track E 的副产品）
6. Coverage ≥ 85%、核心模块 mutation score ≥ 80%（Track K）

---

## 8. 参考

- 源蓝图：`~/Documents/Downloads/harness-one-testing-strategy.md`
- 架构文档：`docs/architecture/00-overview.md` 起
- 已有测试基础：`packages/core/src/testing/`（`createMockAdapter` 等）
