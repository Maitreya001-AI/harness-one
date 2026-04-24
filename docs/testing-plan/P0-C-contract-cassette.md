# Track C · 契约 suite + Cassette（P0）

**预估工时**：7 天（INFRA-A 半天 → INFRA-B 2 天 → INFRA-D 2 天 → adapter 契约 2-3 天）
**依赖**：需要真实的 `ANTHROPIC_API_KEY` 和 `OPENAI_API_KEY`（少量调用，预算 < $5）

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-C -b testing/track-C-contract-cassette main
cd ../harness-one-track-C
pnpm install --frozen-lockfile

# 准备 API key（本 worktree 私有，不入 git）
cp .env.example .env  # 如果有
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.local
echo "OPENAI_API_KEY=sk-..." >> .env.local

claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-C-contract-cassette`）。harness-one 提供 `AgentAdapter` 接口，目前实现有 `@harness-one/anthropic`（`packages/anthropic/`）和 `@harness-one/openai`（`packages/openai/`）。

**任务**：建立 adapter 契约测试体系 + 真实 API 响应的 cassette 录制/回放机制。这是 adapter 可信度的核心。

### 先读（必做）

```bash
cat packages/core/src/core/types.ts | head -200     # AgentAdapter 接口
cat packages/anthropic/src/index.ts
cat packages/openai/src/index.ts
ls packages/core/src/testing/
cat packages/core/src/testing/index.ts
cat packages/core/src/testing/test-utils.ts | head -100
find packages -name "*.test.ts" -path "*adapter*" 2>/dev/null | head -5
```

本 track 按顺序做 4 件事，每件完成后独立 commit：

### INFRA-A · Smoke test 脚本（半天）

- 新建 `tools/smoke-test.mjs`（或 `.ts` via tsx）
- 调用真实 Anthropic + OpenAI（读 `.env.local`），跑一次最小 chat + 一次 stream
- 打印 response、usage、拒绝时的错误分类
- **不入 CI**（会消耗 API budget），只在本地 owner 跑
- 加 `pnpm smoke` script

### INFRA-B · Cassette 录制/回放（2 天）

放在 `packages/core/src/testing/cassette/`：

- `record.ts`: 包装 `AgentAdapter`，把 `chat()` / `stream()` 的入参 + 出参（包括 SSE chunk 时序，记录每个 chunk 的相对时间戳）序列化到 `*.jsonl`
- `replay.ts`: `createCassetteAdapter(path: string): AgentAdapter`，按 cassette 回放；匹配 key 基于 `messages + tools + temperature` 的 stable hash
- 文件格式：`packages/core/src/testing/cassette/schema.ts` 明确定义，版本化（`version: 1`）
- 写单测：同一批 cassette，record 后 replay 结果应 byte-equal
- 导出从 `packages/core/src/testing/index.ts`：`createCassetteAdapter`、`recordCassette`
- **不引入新依赖**（用 node:fs、node:crypto）

Cassette 存放目录约定：`packages/<adapter>/tests/cassettes/*.jsonl`（gitignore 规则：record 输出可入 git，API key 出现则拒绝提交）。

### INFRA-D · Contract suite 工厂（2 天）

放在 `packages/core/src/testing/contract/`：

- `createAdapterContractSuite(adapter, fixtures): void`
- 在 vitest 环境里注册 describe/it，跑一组与 adapter 实现无关的断言（≥ 20 条，目标 30 条）
- 每条断言对应 `AgentAdapter` 接口的一个隐式承诺：
  - `chat()` 返回 `AssistantMessage`，`content` 为 string 或 `toolCalls` 数组结构合法
  - `stream()` 依次 yield `text_delta` → (可选 `tool_use_delta`) → `message_stop`
  - `AbortSignal` forward 到底层 SDK，中断时 reject `AbortedError`（用 `harness-one` 自己的错误类）
  - `TokenUsage` 所有字段非负有限数
  - cache 字段（若 adapter 支持）与 input/output 相加逻辑正确
  - `streamLimits.maxToolArgBytes` 在 yield tool_use chunk 前检查
  - 连续两次调用不共享状态（adapter 可重用性）
  - 空 messages 抛 `InvalidConfigError`
  - 非法 tool schema 抛 `InvalidConfigError`
  - ...（参考 `packages/core/src/core/types.ts` 中 `AgentAdapter` 的每个 method）
- `fixtures` 参数传 cassette 目录路径；套件内部自动用 `createCassetteAdapter` 读取
- 导出 `createAdapterContractSuite` 从 `harness-one/testing`

### Adapter 契约落地（2-3 天）

#### Anthropic
- 新建 `packages/anthropic/tests/contract.test.ts`
- 录 cassettes：用 INFRA-A 的 smoke 基础，跑一遍 record 脚本把 fixtures 录到 `packages/anthropic/tests/cassettes/`
- 调用 `createAdapterContractSuite(createAnthropicAdapter(...), { cassetteDir: 'tests/cassettes' })`

#### OpenAI
- 同上，`packages/openai/tests/contract.test.ts` + `packages/openai/tests/cassettes/`

#### Nightly re-record workflow
- 新建 `.github/workflows/cassette-drift.yml`，`schedule: cron '0 6 * * *'`
- 用 repo secret `ANTHROPIC_API_KEY_CI` / `OPENAI_API_KEY_CI`
- 步骤：重新 record cassettes → `git diff` → 有 diff 就开 issue（用 `peter-evans/create-issue-from-file`）
- 不自动 commit；issue 让维护者人工 review

### File Ownership

- `packages/core/src/testing/cassette/**`（新建）
- `packages/core/src/testing/contract/**`（新建）
- `packages/core/src/testing/index.ts`（加 export）
- `packages/core/src/testing/__tests__/**`（新建相关单测）
- `packages/anthropic/tests/contract.test.ts` + `tests/cassettes/**`（新建）
- `packages/openai/tests/contract.test.ts` + `tests/cassettes/**`（新建）
- `tools/smoke-test.mjs`（新建）
- `.github/workflows/cassette-drift.yml`（新建）
- `package.json`（root，加 `smoke` script）
- `docs/architecture/17-testing.md`（**必须更新**，描述 cassette + contract 层）

**不要碰**：adapter 源码（`packages/anthropic/src/**`、`packages/openai/src/**`）、`packages/core/src/core/**`、其他 Track 路径。

### DoD / 验收

- [ ] `pnpm smoke` 本地可跑，真实 API key 下双 adapter 都返回有效 response
- [ ] `pnpm test` 在 `packages/core` 下能跑通 cassette record/replay 的单测
- [ ] `pnpm test --filter @harness-one/anthropic` 契约套件全绿，不消耗 API quota（用 cassette）
- [ ] `pnpm test --filter @harness-one/openai` 同上
- [ ] Cassette 文件 < 50KB/个，无明文 API key
- [ ] `docs/architecture/17-testing.md` 更新，包含 cassette + contract 章节
- [ ] Nightly workflow yml 通过 `actionlint`
- [ ] Contract suite 断言 ≥ 20 条

### 纪律

1. 改动 `packages/core/src/testing/` 属于架构面变更，**必须同步更新 `docs/architecture/17-testing.md`**
2. `AgentAdapter` 接口如果因契约测试发现歧义，**不要擅自改接口**，在 PR 描述里 flag 给 owner
3. 不引入新运行时依赖到 `@harness-one/core`（保持 zero-dep 承诺）
4. Cassette 文件提交前跑 `grep -r "sk-" packages/*/tests/cassettes/` 确保无泄漏
5. Commit 粒度：INFRA-A、INFRA-B、INFRA-D、Anthropic contract、OpenAI contract、Nightly workflow 各自独立 commit

## ---PROMPT END---
