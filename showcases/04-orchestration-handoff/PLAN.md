# PLAN · 04-orchestration-handoff

> Showcase #04:Orchestration Handoff Boundary。
> 形态压力实验,严格按 `harness-one-showcase-method.md` 7 阶段执行。
> 本 PLAN 为起点,实际启动时 cp 到 `showcases/04-orchestration-handoff/PLAN.md` 后细化。

---

## 1. 一句话场景描述

一个最小多 agent 协作场景——Researcher agent 收到查询,通过 handoff 把
精确化任务交给 Specialist agent 执行,Specialist 完成后再 handoff 回
Coordinator 总结输出——全程用 mock adapters 驱动,聚焦验证 orchestration
子系统的 handoff 语义、边界传递、错误传播、tracing 完整性。

---

## 2. 形态定位

**主形态**:多 agent 协作(代表压力:CrewAI / AutoGen / LangGraph 这类
multi-agent 编排器的核心边界语义)

**次形态**:无

**不是**:真实研究 agent(那是 apps/research-collab 干的活),不带真 LLM
也不带真 tools——本 showcase **只压 orchestration 子系统的核心语义**

---

## 3. 压力点清单(8-15 条)

### Handoff 基础语义

1. Researcher → Specialist 的 handoff 携带的 input 字段在 Specialist
   `agent.run()` 入口能被完整读到(类型守恒、内容守恒)
2. Specialist → Coordinator 的 handoff 把 Specialist 的产出按 schema
   传递,Coordinator 拿到后能直接消费
3. handoff 链(A → B → C)的 trace span 串成一条 parent-child 关系完整,
   而不是三个 disjoint root span

### Boundary 隔离

4. agent A 的 budget(token/iteration/duration)**不会**串到 agent B
   ——每个 agent 有自己独立的 budget context
5. agent A 的 session(如果用了)在 handoff 时**不会**自动带到 agent B
   ——边界明确,B 拿到的是新 session 或 explicit 传入的 session
6. agent A 的 abortSignal 触发 abort 时,**正在 handoff 中的下游 B 也被
   abort**(级联中止)

### 错误传播

7. Specialist 抛错 → 错误如何到达 Researcher 是**显式 handoff 路径**而
   不是 silent rejection promise——Researcher 应能 try/catch 处理
8. 错误传播带 stack trace + source agent identifier,debugging 时能
   立刻定位"在哪个 agent 哪一步出的错"
9. 如果 Specialist 超 budget,error 类型为 BUDGET_EXCEEDED 而不是泛化
   `Error`(关联 memory 里讲的 `HarnessErrorCode.TOKEN_BUDGET_EXCEEDED`)

### Schema 验证

10. 不合法的 handoff payload(类型不对、字段缺失)在 handoff 边界**被
    schema 校验拦截**,而不是让下游 agent 在运行中才崩
11. handoff schema mismatch 报错信息包含具体哪个字段哪个 expected vs
    actual,不是泛化的 "validation failed"

### 并发与状态

12. 同一 Researcher 同时 handoff 给 2 个 Specialist(并发分发),两个
    Specialist 的 budget / trace / state 完全隔离
13. 两个并发 Specialist 完成后回到 Researcher,合并语义清晰
    (`Promise.all` 风格还是 first-completed 风格?要确认)

### Tracing & Observability

14. 整个三 agent 的 trace 在 exporter 里能合成一棵完整的 tree:
    Coordinator (root) → Researcher → Specialist (×N if 并发)
15. handoff 的 metadata(at-this-time、from-agent、to-agent、payload-summary)
    在 trace span 里完整记录,不依赖 application-level logging

---

## 4. 涉及的 subsystem

### Primary(主用)

- **orchestration**:多 agent 协调 + handoff 原语 + boundary + cascade abort
- **observe**:trace 跨 agent parent-child 关系

### Secondary(辅用)

- **core**:每个 agent 内部用 AgentLoop(被 mock adapter 驱动)
- **infra**:schema 校验、错误类型(`HarnessErrorCode`)

### Explicitly Avoided(明确不用)

- **rag** / **memory** / **prompt** / **context** / **tools** /
  **guardrails** / **session** / **evolve-check** / **advanced**:全部
  避开,聚焦只压 orchestration

---

## 5. 可观察的成功标准

### 二元 pass/fail(必须有)

- ✅ **PASS**:
  - 三 agent handoff 链 100 次连续运行无失败、无 leak
  - 错误传播测试(故意让 Specialist 抛错):错误带正确 type + source
    agent + 完整 stack trace 100% 到达 Researcher
  - 并发分发测试(Researcher → 2 Specialists)10 次:每次两个
    Specialist budget / trace 完全隔离
  - cascade abort 测试 10 次:abort Coordinator 后,Researcher 和
    所有 Specialist 都在 < 200ms 内 abort
- ❌ **FAIL**:任何一项不满足

### 数值上限

- 单次三 agent handoff 链 wall clock < 1 秒(全 mock,所以纯计算开销)
- 100 次连续运行 RSS 增长 < 20 MB(无泄漏)
- 不调用真实 LLM API,**总成本 = $0**

### Trace 完整性

- 100 次 run 共 100 棵 trace tree,每棵都是 parent-child 完整(无
  orphan span,无未关闭 span)
- 并发分发的两个 Specialist span 都正确归属同一 Researcher 父 span

---

## 6. 明确的非目标

- ❌ 不验证真实 LLM 行为(全程 mock adapter)
- ❌ 不验证多 agent 真的能"协作好"(那是 apps/research-collab 的活)
- ❌ 不实现复杂的 agent personality / role-playing(每个 agent 就是
  一个 mock fn)
- ❌ 不验证 RAG / tools / 其他子系统的协同
- ❌ 不验证跨进程 handoff(单进程内 handoff)
- ❌ 不优化 orchestration 性能本身(发现性能问题就记到 OBSERVATIONS)
- ❌ 不实现 CrewAI / AutoGen 风格的高层 DSL(刻意保持低层 API 调用)

---

## 7. 实施 sketch

预期文件结构:

```
showcases/04-orchestration-handoff/
  src/
    main.ts                    # entry,跑 100 次 + 错误注入 + 并发
    agents/
      coordinator.ts           # 总协调 agent(mock fn)
      researcher.ts            # 研究 agent(mock fn)
      specialist.ts            # 专家 agent(mock fn,可注入 error)
    handoff-schemas.ts         # zod / 内置 schema 定义 handoff payload
    test-scenarios.ts          # 各种测试场景定义
    assertions.ts              # trace tree 验证 / boundary 验证
  README.md
```

伪码:

```typescript
// agents/specialist.ts
import { defineAgent } from 'harness-one/orchestration';
import { createMockAdapter } from 'harness-one/testing';

export const Specialist = defineAgent({
  name: 'specialist',
  inputSchema: SpecialistInputSchema,
  outputSchema: SpecialistOutputSchema,
  budget: { tokens: 5_000, iterations: 3, durationMs: 10_000 },
  async run({ input, signal, trace }) {
    // mock adapter 驱动一轮 chat
    const adapter = createMockAdapter({
      responses: [{ message: { role: 'assistant', content: `Analyzed: ${input.topic}` } }],
    });
    // ... AgentLoop 一次
    return { analysis: '...', confidence: 0.9 };
  },
});

// agents/researcher.ts
export const Researcher = defineAgent({
  name: 'researcher',
  async run({ input, handoff, signal }) {
    const subResults = await Promise.all([
      handoff(Specialist, { topic: 'A' }),
      handoff(Specialist, { topic: 'B' }),  // 并发分发测试
    ]);
    return { synthesis: subResults.map(r => r.analysis).join(' | ') };
  },
});

// main.ts
async function runScenario(scenario: TestScenario) {
  const orchestrator = createOrchestrator({ rootAgent: Coordinator });
  const trace = await orchestrator.run(scenario.input);
  await runAssertions(trace, scenario.expectations);
}

async function main() {
  for (let i = 0; i < 100; i++) {
    await runScenario(SCENARIOS.happyPath);
  }
  await runScenario(SCENARIOS.errorInSpecialist);
  await runScenario(SCENARIOS.budgetExceeded);
  for (let i = 0; i < 10; i++) {
    await runScenario(SCENARIOS.cascadeAbort);
  }
  // ...
}
```

**注意**:`defineAgent` / `createOrchestrator` / `handoff` 这些 API 名字
是占位——实际启动时打开 `harness-one/orchestration` 源码确认真实公开 API。
本 PLAN 不预设 API shape,只定义压力点。如果真实 API 跟 PLAN 假设差异
很大,在 HYPOTHESIS 阶段记录"orchestration API 比预期复杂/简单"作为
反哺信号。

---

## 8. Hypothesis 起点

✅ **预期顺利**:

- orchestration 子系统已有基础单测覆盖
- mock adapter 驱动单 agent 已验证(showcase 01 / 03 用过)
- trace span 的 parent-child 在单 agent 内已工作

⚠️ **担心有问题**:

- **handoff 边界的 budget 隔离**——这事在多 agent 场景才暴露,
  单 agent 单测覆盖不到。可能存在"budget context 不小心被父 agent 污染"
  的 bug
- **cascade abort 的传播延迟**——AbortSignal 跨 promise boundary 是
  立即生效还是有延迟?多层嵌套时累积延迟有多大?
- **并发分发时的 trace tree 合成**——两个 Specialist span 的 parent
  reference 是 Researcher 同一个 span 还是各自的?如果 trace exporter
  buffer 时序不对,可能合成成两棵分离 tree
- **错误传播路径**——Specialist 抛错时,error 在 trace 里是 attached 到
  Specialist span 还是 Researcher span?调试体验直接由这个决定
- **schema 校验失败时的 error 形态**——是 throw 还是 return Result-style?
  这是 API 设计选择,可能跟我预期不同
- **Researcher 并发分发是不是真的并发**——会不会内部串行化了?
  (per memory: harness-one 文档强调"thin harness"避免 graph DSL,
  但并发执行还是要支持)

❓ **完全不知道**:

- handoff 的 payload 大小有上限吗?如果传一个 100MB 的对象会怎样?
- 多 agent 场景下 cost tracking 是 per-agent 还是合一?这关系到 budget
  是否真的能 per-agent 隔离
- session reuse 跨 handoff 是否有 sane default(默认是新 session?
  还是父 agent 的 session 共享?)
- "thin harness" 哲学下,本 showcase 测的"orchestration"到底是 harness
  提供的还是用户自己组合 AgentLoop 实现的?(memory 提到避免 graph DSL,
  但 orchestration 子系统应该有 handoff 原语;这个边界要在 PLAN 阶段
  对照源码确认)

---

## 9. PLAN review checklist

- [ ] 压力点 15 条,每条可观察 ✓
- [ ] 二元 pass/fail 标准存在 ✓ (100 次链 + 错误传播 + 并发 + cascade abort)
- [ ] 形态坐标单一 ✓ (orchestration handoff)
- [ ] 非目标清晰 ✓
- [ ] Primary subsystem(orchestration)所有压力点都有覆盖
- [ ] **没有跑题**:压力点都聚焦 orchestration 边界语义,没飘到 LLM
      行为或单 agent 内部
- [ ] 工时预估在 timebox 内(MVP 2-3 天,完整 7 阶段 7-10 天)

---

## 10. 给 reviewer 的关键关注点

1. **跟 "thin harness" 哲学的张力**:memory 里明确"harness-one 反对 graph
   DSL / LangGraph executor / OpenAI handoff 模式"——但 orchestration
   子系统又有 handoff 原语。如何区分:
   - **harness 提供**:handoff 原语(API 调用方式)+ boundary 语义
     + tracing 串联 + budget 隔离机制 = **机制(mechanism)**
   - **用户/skill 决策**:什么时候 handoff、给哪个 agent、合并策略 =
     **策略(policy)**
   - 本 showcase 验证的是机制层的健壮性,不是策略层的合理性。
     这点要在 ARCHITECTURE.md 文档里有清晰阐述,本 showcase 反哺的
     发现可能促成 ARCHITECTURE.md 更新

2. **跟 apps/research-collab 的边界**:
   - 本 showcase = orchestration 子系统**机制**的形态压测
   - apps/research-collab = orchestration 在真实长链路 agent 协作中**策略
     选择 + 长期反哺**
   - 不重叠不冗余,但要相互引用

3. **关于"100 次连续运行"的合理性**:
   - 100 次在全 mock 场景下 < 1 秒,几乎无性能压力
   - 真实价值在于**多次 run 让 leak / drift / state pollution** 显现
   - 如果某个 run 行为跟前一个 run 不同(同样 input 不同 output),
     说明有 cross-run state pollution——这正是本 showcase 要发现的

4. **跟 03-memory-checkpoint-stress 的"crash injection"模式对照**:
   - 03 是进程级故障注入(SIGKILL)
   - 本 showcase 是逻辑级故障注入(Specialist 抛错、budget exceed)
   - 不重叠

---

## 11. 启动前 owner 决策清单

- [ ] timebox 拍板:2-3 天 MVP,7-10 天完整 7 阶段
- [ ] budget 拍板:$0(全 mock)
- [ ] orchestration 子系统的真实 API shape 是什么?
  - 启动 PLAN 第一天 0.5 天:打开 `packages/core/src/orchestration/`
    或对应位置,read 接口定义,把"压力点"映射到具体 API 调用路径
  - 如果 API shape 跟 PLAN 假设差异大,**先回到 PLAN 阶段调整,不进 Build**
- [ ] 100 / 10 这些数字合适吗?
- [ ] 跟 ARCHITECTURE.md 的"反对 graph DSL"声明,本 showcase 怎么
      措辞才不冲突?(建议:README 里明确"本 showcase 验证 mechanism 层
      handoff 健壮性,不验证或推荐特定策略层 DSL")

---

## 12. 跟其他 showcase 的协同

- 本 showcase **唯一**主压 `orchestration` 子系统的机制层
- 跟 `01-streaming-cli` 无重叠(那边单 agent)
- 跟 `02-rag-support-bot` 无重叠(那边单 agent + RAG)
- 跟 `03-memory-checkpoint-stress` 无重叠(那边单进程多 task,memory)
- 跟 `apps/research-collab/` 强相关:本 showcase 发现的 orchestration
  问题,直接影响 research-collab 上线稳定性

---

## 13. 关于"orchestration 子系统的形态层覆盖"的明确

orchestration 子系统在 form-coverage 矩阵里有两个层级覆盖:

- **本 showcase**(短期、聚焦):机制层语义压测,7 阶段方法论,可控可重现
- **apps/research-collab**(长期、综合):真实多 agent 协作,长链路压测,
  长期反哺

两者**互补不重叠**:本 showcase 在小规模隔离场景下发现的 bug 通常是
"几乎所有用法都会触发"的根本性问题;apps/research-collab 在真实场景下
发现的 bug 通常是"特定使用模式才暴露"的边缘性问题。**两条路径都需要,
缺一不可**。

如果只有 apps/research-collab 没有本 showcase,等到长链路压测发现 bug
时,debug 成本极高(很难定位是哪一层的问题)。本 showcase 在受控环境下
提前消除大部分根本性问题。
