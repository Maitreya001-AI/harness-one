# PLAN · 03-memory-checkpoint-stress

> Showcase #03:Memory Checkpoint Stress。
> 形态压力实验 + memory 子系统 stress test 一份工时两份收益。
> 严格按 `harness-one-showcase-method.md` 7 阶段执行。
> 本 PLAN 为起点,实际启动时 cp 到 `showcases/03-memory-checkpoint-stress/PLAN.md` 后细化。

---

## 1. 一句话场景描述

一个长循环 mock agent 用 mock adapter 模拟 200 轮 long-context 迭代,
全程依赖 CheckpointManager + ContextRelay 跨 context window 持久化进度,
中途 inject 进程 crash(SIGKILL)→ 重启 → 验证恢复后状态完整、无 fs index
错乱、无脏数据。

---

## 2. 形态定位

**主形态**:长时运行 + 自主循环(代表压力:Claude Code 这类 agent 的
checkpoint 持久化层)

**次形态**:无

**不是**:真实编码 agent(那是 apps/coding-agent),不带真 LLM 也不带真
shell tools——本 showcase **只压 memory 子系统**,所有非 memory 的部分都
mock 掉

---

## 3. 压力点清单(8-15 条)

### CheckpointManager 持久化

1. CheckpointManager 写 200 个 checkpoint,每个含中等 size(~10 KB)的
   状态对象,写完后能全部读出
2. 写过程中**任意一个**节点 SIGKILL 进程 → 重启 → `cm.load()` 不抛
   STORE_CORRUPTION,且能定位到最后一个完整 checkpoint
3. 部分写入(写到一半被 SIGKILL)的 checkpoint 文件不会被加载为有效数据

### FsMemoryStore 索引一致性

4. 写 1000 个 entries → 读 `_index.json` → 每个 key 都有对应的合法 entry 文件
5. 进程 crash 中 `_index.json` 写到一半被截断 → 重启时 `parseJsonSafe`
   优雅降级,通过 `onCorruption` callback 报告但不崩
6. 并发写 100 个 entries(同一进程内)→ 索引锁串行化保证最终 index 完整

### ContextRelay 持久化

7. RelayState 写入 → kill → 重启 → load 出来的 RelayState 跟写入时
   shape 一致(progress / artifacts / checkpoint 字段全对)
8. 损坏 RelayState 文件(手动改一个字段类型)→ load 时 validateRelayState
   抛 STORE_CORRUPTION 而不是返回伪造对象

### 容量与清理

9. CompactionPolicy 启动后,gradeWeights < 1.0 的旧 entries 被清理,
   critical grade 的 entries 不被清理
10. compact 过程中 SIGKILL → 重启后 index 跟实际 entry 文件**一致**
    (不存在"index 说有但文件已删除"的撕裂状态)

### 跨 context window 接力

11. mock 200 轮 iteration 中,每 50 轮触发"context window 满 → 通过
    relay 接力到下一 context"。重启后接力链不断
12. relay 链的 `_version` 字段保证向后兼容(用旧版本 relay 文件能加载,
    或正确报告版本不兼容)

### 性能边界

13. 1000 entries 下 `query()` p95 < 100ms(per perf baseline I3)
14. 200 个 checkpoints 持续写,RSS 增长 < 50 MB(无线性泄漏)

---

## 4. 涉及的 subsystem

### Primary(主用)

- **memory**:FsMemoryStore + CheckpointManager + ContextRelay + CompactionPolicy
- **infra**:`parseJsonSafe`、async-lock、validation schemas

### Secondary(辅用)

- **observe**:trace 每个 checkpoint write/read 操作
- **core**:用 mock AgentLoop 驱动循环(不是被验证对象)

### Explicitly Avoided(明确不用)

- **rag** / **orchestration** / **prompt** / **context** / **tools** /
  **guardrails** / **session** / **evolve-check** / **advanced**:全部
  避开,聚焦只压 memory

---

## 5. 可观察的成功标准

### 二元 pass/fail(必须有)

- ✅ **PASS**:
  - 200 轮迭代每轮 checkpoint 写入成功,中途 inject 5 次 SIGKILL,
    每次 restart 都能恢复且无数据丢失 / corruption
  - 故意损坏 entry 文件 100% 被 schema 校验捕获,不混入业务数据
  - 1000 entries 并发写测试无 index 撕裂
- ❌ **FAIL**:任何一项不满足

### 数值上限

- 200 轮迭代 + 5 次 crash recover 总 wall clock < 5 分钟
- 不调用真实 LLM API,**总成本 = $0**(全 mock)
- p95 entry write 延迟 < 50ms
- p95 entry query 延迟 < 100ms

### 数据完整性

- 写入 N 个 entries → 读出 N 个,内容字节相等
- crash 后恢复:lost entries 数量 ≤ 1(只允许丢正在写的那条)

---

## 6. 明确的非目标

- ❌ 不验证真实 LLM 行为(全程 mock adapter)
- ❌ 不验证 RAG / tools / guardrails / orchestration 等其他子系统
- ❌ 不验证多进程并发(单进程多 task)
- ❌ 不验证非 fs 后端(如 Redis adapter 由 `@harness-one/redis` 自己测)
- ❌ 不优化 fs 性能本身(发现性能问题就记到 OBSERVATIONS,不在 showcase 内修)
- ❌ 不演示 vector search(虽然 memory 模块支持,本 showcase 不用)

---

## 7. 实施 sketch

预期文件结构:

```
showcases/03-memory-checkpoint-stress/
  src/
    main.ts                # entry,跑 200 轮 + crash injection
    mock-agent.ts          # mock 长循环 agent
    crash-injector.ts      # 在指定 iteration 触发 SIGKILL 的辅助
    corruption-injector.ts # 手动损坏 entry 文件做 corruption test
    assertions.ts          # 各种数据完整性断言
    runner.ts              # supervisor 进程,负责 fork + 重启 child
  test-data/
    seed-state.json        # 初始 state
  README.md
```

整体架构:**双进程模式**

- supervisor 进程:fork child,在指定 iteration 给 child 发 SIGKILL,
  然后 fork 新 child 让它从 checkpoint 恢复继续跑
- child 进程:跑 mock-agent,每轮写 checkpoint,通过 stdout 报告进度

伪码:

```typescript
// runner.ts (supervisor)
async function runStressTest() {
  const crashAt = [40, 90, 140, 175, 195];  // 5 次 crash 注入

  let resumedFromIteration = 0;
  for (const targetCrash of [...crashAt, 200]) {
    const child = fork('child.js', [String(resumedFromIteration), String(targetCrash)]);
    const result = await waitForChildExit(child);
    resumedFromIteration = result.lastCheckpoint;
    if (result.exitReason !== 'crash_injected') break;
  }

  // After all 200 iterations + 5 recoveries: assert state integrity
  await runDataIntegrityAssertions();
}

// child.ts
async function childAgent(resumeFrom: number, crashAt: number) {
  const cm = createCheckpointManager({
    store: createFileSystemStore({ dir: 'checkpoints' }),
  });

  let state = await cm.load() ?? initialState();
  for (let i = state.iteration; i < 200; i++) {
    state = doMockWork(state);
    await cm.save(state);
    if (i === crashAt) {
      process.kill(process.pid, 'SIGKILL');
    }
  }
}
```

---

## 8. Hypothesis 起点

✅ **预期顺利**:

- FsMemoryStore 单测覆盖 read/write/delete/clear 完整
- index 锁的实现已通过单测
- validateMemoryEntry / validateIndex 等 schema 校验函数功能正确

⚠️ **担心有问题**:

- index 锁是**进程内**的(memory 文档明说不适用多进程)。
  本 showcase 是单进程多 task,理论上 OK,但跨 crash 重启的"前一个进程
  的锁状态"会不会有残留?(猜测:fs 上没有 lock file,所以无残留——
  但要验证)
- `_index.json` 写入是不是原子的?如果不是(POSIX rename 才原子),
  在写到一半被 kill 时可能留下损坏 index
- compact() 中途 crash 后 index 跟文件的撕裂状态——这个内置实现里有处理吗?
- 1000 entries 并发写的真实压力,跟单测覆盖的小规模不同
- ContextRelay 的 `__relay__` 特殊 key,在 crash 恢复时 cache 里的 currentId
  可能残留——需要验证 invalidation 路径

❓ **完全不知道**:

- 真实生产 use case 中,checkpoint 频率多高合理?如果是每轮都写,
  N 轮后 fs 上有 N 份文件,compact 怎么决策保留哪些?
- crash 时 OS page cache 还没 flush 的数据,在 fsync 缺失情况下会丢吗?
  (memory 模块当前是否调用 fsync?——需要查源码)
- 在 macOS APFS / Linux ext4 / Windows NTFS 上行为差异多大?
  (本 showcase 在 Linux CI 跑,但生产 user 可能在 macOS)

---

## 9. PLAN review checklist

- [ ] 压力点 14 条,每条可观察 ✓
- [ ] 二元 pass/fail 标准存在 ✓ (200 轮 + 5 次 crash 全 recover)
- [ ] 形态坐标单一 ✓ (memory stress)
- [ ] 非目标清晰 ✓
- [ ] Primary subsystem(memory)所有压力点都有覆盖
- [ ] **没有跑题**:压力点都聚焦 memory,没飘到 LLM 或 tools 行为
- [ ] 工时预估在 timebox 内(MVP 2-3 天,完整 7 阶段 7-10 天)

---

## 10. 给 reviewer 的关键关注点

1. **跟 stress test 骨架的关系**:memory 里规划过 "crash recovery for
   FsMemoryStore" stress test。本 showcase 是这件事的**形态级 showcase 形态**,
   不是 unit test 也不是单纯 perf bench。两件事的关系:
   - stress test 骨架文件(假设落在 `packages/core/tests/perf/` 或类似)
     吸收本 showcase 的 mock-agent + crash-injector 代码作为基础,**不重复实现**
   - showcase 完成后,简化版本的 crash recovery test 可以进 CI
     (cassette + mock,deterministic)
   - 复杂版本(全 200 轮 + 5 crash)留作 nightly 或手动触发
2. **chaos test 层 vs 本 showcase**:chaos test 是 adapter 级别故障注入
   (`createChaosAdapter`)。本 showcase 是 OS 进程级别故障(SIGKILL)。
   不重叠,互补
3. **关于"corruption test"的伦理**:故意损坏 fs 文件来测 schema 校验,
   听起来像作弊。但这正是 schema 校验存在的理由——任何持久化层在生产中
   都会遇到 partial write、版本迁移、字节翻转、磁盘错误。**不通过这种
   测试,schema 校验等于摆设**

---

## 11. 启动前 owner 决策清单

- [ ] timebox 拍板:2-3 天 MVP,7-10 天完整 7 阶段
- [ ] budget 拍板:$0(全 mock)
- [ ] 200 轮 / 1000 entries / 5 crash 这些数字合适吗?太多?太少?
- [ ] 在 Linux CI 跑足够还是要加 macOS 矩阵?(当前 perf baseline 只
      gate Linux,本 showcase 跟 perf 一致即可)
- [ ] crash injection 用 SIGKILL 还是 SIGTERM?
  - SIGKILL 更狠(模拟 OOM kill / 突然断电)
  - SIGTERM 给 graceful shutdown handler 机会(模拟正常 docker stop)
  - 建议:**主要用 SIGKILL**(SIGTERM 路径在 streaming-cli showcase 已覆盖)
- [ ] 跟 stress test 骨架是合并到本 showcase 还是分开?
  - 推荐:合并。一份代码,两份产出物(showcase 7 阶段 + perf baseline 入口)

---

## 12. 跟其他 showcase 的协同

- 本 showcase **唯一**主压 `memory` 子系统
- 跟 `apps/coding-agent/` 强相关:coding-agent 长链路 agent 一定会用
  CheckpointManager。本 showcase 提前发现的问题,直接推进 coding-agent
  上线时的稳定性
- 跟 `04-orchestration-handoff` 无重叠
- 跟 chaos test 互补(adapter level vs process level)

---

## 13. 关于"stress test 双重身份"的明确

本 showcase 同时承担两个角色:

**角色 A:Showcase #03**(本文档主语境)

- 严格按 7 阶段方法论
- 6 份产出物
- 进 cassette CI(简化版本)

**角色 B:Memory 子系统 stress test 形态层**

- 复杂版本(200 轮 × 5 crash)留作 stress test,可手动触发
- 跟 perf baseline workflow 共享 fixtures

**当本 showcase 完成时,角色 B 自动满足**——不需要再单独排期 memory
stress test 工作。这就是 form-coverage 文档里说的"一份工时两份收益"。

如果将来角色 A 和 B 演化产生分歧(比如 stress test 想加更多场景),
再考虑拆分。当前合并实现。
