# Track D · 跨子系统集成 scenario（P0）

**预估工时**：5 天（5 必做 × 1 天 + 3 可选）  **依赖**：无（用 `createMockAdapter`）

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-D -b testing/track-D-integration main
cd ../harness-one-track-D
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-D-integration`）。harness-one 的单测（4486+）覆盖了单个模块，但**单测 → E2E 之间的"跨子系统集成"层最稀疏**。本 track 补齐 5-8 个最关键的 scenario。

**原则**：每个 scenario 把 2-3 个真实 subsystem 接起来跑，**不 mock 任何 harness 自家代码**，只用 `harness-one/testing` 里的 `createMockAdapter` 替换 LLM。

### 先读（必做）

```bash
ls packages/core/src/
cat packages/core/src/core/agent-loop.ts | head -100     # 或等价入口
cat packages/core/src/testing/test-utils.ts | head -80
find packages/core/src -name "index.ts" | head
grep -rn "createTraceManager\|createCostTracker\|createGuardrail" packages/core/src --include="*.ts" | head -20
ls packages/core/src/**/__tests__/ 2>/dev/null | head
find . -path '*/tests/integration*' -type d 2>/dev/null
```

### 放哪里

新建 `packages/core/tests/integration/` 目录（如不存在），每个 scenario 一个文件：

```
packages/core/tests/integration/
  agentloop-trace-cost.test.ts       # D1
  guardrails-fail-closed.test.ts     # D2
  tools-parallel-error.test.ts       # D3
  fallback-retry.test.ts             # D4
  session-memory-relay.test.ts       # D5
  rag-indexscoped.test.ts            # D6（可选）
  streaming-limits.test.ts           # D7（可选）
  secure-preset-e2e.test.ts          # D8（可选）
  fixtures/                          # 共享 fixtures
```

vitest 会自动 pick up `.test.ts`，无需新配置。

### 任务清单（每个 scenario 独立文件、独立 commit）

#### D1 · `AgentLoop + traceManager + costTracker` 口径一致
- 跑一次 mock LLM 的 `harness.run(...)`（含 2-3 个 tool call）
- 断言：`trace.spans.length === 预期值`、`costTracker.totalUsd === span 累加`、`tokenUsage` 三个来源数字一致
- 失败信号：任何一个口径漂移即挂

#### D2 · Guardrails 三 hook + failClosed
- 配置 input / output / tool guardrail 各一个，都设 `fail: true`
- 分别触发 input block / output block / tool block
- 断言：每次都正确终止、产生 `guardrail_blocked` 事件、后续 run 不受污染（重新 run 能 pass）
- 断言 event sequence 顺序稳定

#### D3 · `tools registry + 并行 + 单 tool 抛错`
- 注册 3 个 tool，并行策略开启；触发 LLM 返回 3 个并行 tool call
- 一个 tool 故意 throw，其他 2 个正常返回
- 断言：worker pool 不卡死、2 个正常 tool 结果回流、错误 tool 走 `toolError` 事件（不是 uncaught）、整个 run 能推进到下一轮

#### D4 · `fallback adapter + retry + backoff`
- 主 adapter 用 `createFailingAdapter` 抛 429
- fallback adapter 用 `createMockAdapter` 正常返回
- 配 `retry: { maxAttempts: 3, backoff: ... }` + one-way breaker
- 断言：retry 次数符合 `createBackoffSchedule` 输出、breaker 触发后后续 run 直接走 fallback、fallback 结果带正确分类标签（`degraded: true` 或等价）

#### D5 · `sessionManager + memoryStore(file-system) + ContextRelay`
- 用 temp dir 起 filesystem store
- 跑 3 次 run，每次在 relay 里写 memory；第 2 次和第 3 次之间让 session TTL 过期
- 断言：TTL 到期后 memory entry 状态正确（保留或清除，按实现约定）
- 人为破坏 index 文件（写乱 bytes），调 `reconcileIndex()`，断言能恢复到一致状态

#### D6（可选）· `RAG + indexScoped + guardrail`
- 两个 tenant 共用同一个 retriever，`indexScoped: tenant-a` / `tenant-b`
- 注入跨租户 query，断言永不串
- 检索结果里塞一条 prompt injection payload，guardrail 应拦截并阻断 retrieval

#### D7（可选）· `streaming + maxStreamBytes + StreamAggregator 重试`
- mock adapter 流式吐出 > `maxStreamBytes` 字节，中间失败一次
- 断言：累积字节计数器跨失败尝试不重置、超限时抛 `StreamLimitExceededError`（或等价）、`AbortedError` 语义正确

#### D8（可选）· `createSecurePreset` 端到端
- 起一个 secure preset
- 试图发起 `network` tool 调用 → 应被 capability allow-list 拦
- 输入里塞 API key pattern → 应被 redact
- Output 包含 secret → 应被 redact
- 断言默认配置真的 fail-closed

### fixtures 规范

`packages/core/tests/integration/fixtures/`：
- `mock-llm-responses.ts`: 共享 LLM 响应 fixture
- `temp-dirs.ts`: `useTempDir()` helper（创建 + afterEach 清理）
- 共享 fixture 必须小（每文件 < 100 行），不要泛化过度

### File Ownership

- `packages/core/tests/integration/**`（新建）
- `packages/core/vitest.config.ts`（仅当 include glob 需要扩）
- `docs/architecture/17-testing.md`（**必须更新**，描述集成测试层）

**不要碰**：`packages/core/src/**`（源码，仅读不改）、`packages/*/src/**`、其他 Track 路径。

### DoD / 验收

- [ ] 至少 5 个必做 scenario（D1-D5）全绿
- [ ] 每个 scenario 文件 < 200 行，单一责任
- [ ] 所有断言窄到只测一件事（一个 `it` 只 assert 一组紧密相关的不变量）
- [ ] 测试名描述行为：`it('accumulates cost monotonically across parallel tool calls')` 而不是 `it('works')`
- [ ] 无 `try/catch + expect(true)` 吞错模式
- [ ] 无 flaky（本地跑 20 次 100% 通过：`for i in {1..20}; do pnpm test --filter @harness-one/core -- integration || break; done`）
- [ ] `docs/architecture/17-testing.md` 更新，列出每个 scenario 验证的不变量
- [ ] Coverage 不降

### 纪律

1. **不 mock harness 自家代码**——只 mock LLM adapter
2. 发现真实 bug（非测试问题）时，**不要擅自改源码修掉**，单独开 issue / 在 PR 里 flag 给 owner
3. `docs/architecture/` 必改（测试层架构变化）
4. Commit 粒度：每个 scenario 一个 commit（D1 一个、D2 一个……）
5. 不引入新依赖

## ---PROMPT END---
