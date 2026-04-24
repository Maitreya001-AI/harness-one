# Track J · Property-based Testing（P1）

**预估工时**：5 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-J -b testing/track-J-pbt main
cd ../harness-one-track-J
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-J-pbt`）。PBT 能捕获**你想不到的输入组合**——一条 property 顶 50 条手写 case。

**任务**：加 `fast-check` 到 devDependencies，为 8 个核心模块各写一条 property 测试。

### 先读

```bash
cat packages/core/package.json | jq '.devDependencies'
grep -rn "pruneConversation\|createBackoffSchedule\|CostTracker\|priceUsage" packages/core/src --include="*.ts" | head -20
find packages/core/src -name "lru*" -o -name "cache*" 2>/dev/null
find packages/core/src -name "*stream-aggregator*" -o -name "*filesystem-store*"
```

### 依赖

在 `packages/core/package.json` 加 `fast-check` 到 devDependencies（最新 stable major，pin minor）。不加运行时依赖。

### 目录

每条 property 紧邻被测模块的 `__tests__/`，命名 `*.property.test.ts`（与常规单测区分，便于 glob 选择）。

### 8 条 property（每条独立 commit）

#### J1 · `AgentLoop` 状态机
**Property**: 任意合法事件序列下，`status` 转换图有效；`disposed` 一旦到达永远是终态。
- Arbitrary: `fc.array(fc.constantFrom('start', 'step', 'tool_result', 'error', 'dispose'))`
- 断言：（a）所有转换都在合法集里；（b）`disposed` 之后任何事件都 no-op 或抛；（c）不存在环把你从终态拉回去。

#### J2 · `pruneConversation`
**Property**: 任意 messages + 任意 maxMessages
- 断言：（a）开头连续 system 消息 100% 保留；（b）输出长度 ≤ maxMessages；（c）幂等（prune(prune(x)) === prune(x)）。

#### J3 · `BackoffSchedule`
**Property**: 任意 attempt 数 ≥ 0
- 断言：（a）delay(n) 单调非递减直到 cap；（b）delay(n) ≤ maxDelay；（c）delay(0) 合理（≥ 0）。

#### J4 · `LRU cache`
**Property**: 任意 set/get/evict 操作序列 + 任意 capacity
- 断言：（a）size ≤ capacity；（b）`onEvict` 调用次数 = 实际淘汰次数；（c）最后被 touch 的 key 不在 evict 列表里。

#### J5 · `CostTracker.updateUsage`
**Property**: 任意调用序列（非负 tokens + 非负 prices）
- 断言：token 计数永远非递减（防篡改不变量）；total cost 非递减；无精度漂移（用 Decimal-safe 比较）。

#### J6 · `pricing.priceUsage`
**Property**: 任意非负 tokens + 非负 prices
- 断言：结果非负有限；单位转换正确（per-1k-token）；空 usage → 0。

#### J7 · `StreamAggregator` UTF-8 字节计数
**Property**: 任意 unicode 字符串（包括 emoji、4-byte、CJK、RTL）
- 断言：aggregator 统计的字节数 === `Buffer.byteLength(s, 'utf8')`。
- 这条特别要把 Arbitrary 开到 `fc.fullUnicodeString()`。

#### J8 · `FileSystemStore` 操作序列 + crash 注入
**Property**: 任意 write/delete/compact 序列 + 随机 crash 点（模拟 process kill）
- 断言：`reconcileIndex()` 后总能恢复一致（索引 ↔ 实际文件 match）。
- 用 `fc.commands` 模式建模（fast-check 的 state-machine API）。
- 单条 property 运行可能慢，限制 `numRuns: 200`。

### 通用规则

- 每条 property 的 `numRuns` 至少 100，关键 property（J7、J8）至少 500
- 用 `fc.assert` 失败时**让 seed 被打印**（方便定位）：
  ```ts
  fc.assert(fc.property(arb, predicate), { seed: process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined });
  ```
- 发现的 counterexample：
  - 如果是测试 bug，**修 property / Arbitrary**
  - 如果是源码 bug，**不要擅自改源码**，开 issue 在 PR 描述里 flag

### File Ownership

- `packages/core/src/**/__tests__/*.property.test.ts`（新建，每个模块旁）
- `packages/core/package.json`（加 `fast-check` devDep）
- `docs/architecture/17-testing.md`（**必须更新**，新增 PBT 章节）

**不要碰**：源码、其他 Track 路径。

### DoD / 验收

- [ ] 8 条 property 全绿
- [ ] 每条至少 100 numRuns（J7/J8 ≥ 500）
- [ ] 失败可重现（seed 环境变量）
- [ ] 无 flaky（固定 seed 跑 20 次 100% 一致）
- [ ] 总 PBT 套件跑 < 30 秒（若超，缩小 numRuns 到最小保证覆盖）
- [ ] `docs/architecture/17-testing.md` 更新
- [ ] CI 跑 PBT（走现有 `pnpm test`，不需要新 job）

### 纪律

1. 不改源码
2. `fast-check` 仅进 `@harness-one/core` devDependencies
3. Arbitrary 定义避免偏向 happy path（用 `fc.oneof` 混 edge case）
4. 改测试层架构，更新 `docs/architecture/`
5. Commit 粒度：每条 property 一个 commit；`fast-check` 依赖添加一个独立 commit

## ---PROMPT END---
