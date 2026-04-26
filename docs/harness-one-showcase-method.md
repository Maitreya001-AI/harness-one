# harness-one Showcase 方法论

> showcases/ 目录下项目应遵循的 7 阶段执行流程。本文档替代旧的
> `harness-one-showcase-workflow.md`,主要修订是路径引用更新到
> `showcases/<n>/`(原为 `examples/showcases/<n>/`)。

---

## 核心心态:Showcase 不是产品,是实验

先把正确的期待讲清楚,否则所有流程都会跑偏:

**Showcase 是什么**

- 一次针对 harness-one 的**生产级使用模拟**
- 一组**可验证的假设测试**(假设:"harness 能 cover 这个形态")
- 给测试体系、API 设计、文档的**反馈生成器**
- 给未来开源用户的**参考实现**和回归防线

**Showcase 不是什么**

- 不是产品,不用追求完整性
- 不是给用户用的工具(那是 apps 的角色)
- 不是"证明 harness 很牛"的营销材料
- 不是写完就不管的一次性脚本(那是 examples 的角色)

这个定位决定了后面所有流程。**showcase 跟 examples 和 apps 的区别**见
`harness-one-form-coverage.md`。

---

## 整体生命周期

```
[Plan] → [Hypothesis Freeze] → [Build] → [Observe] → [Harvest] → [Feed Back] → [Archive & Regress]
  ↑                                                                                    ↓
  └────────────────── 下一个 showcase 的设计输入 ─────────────────────────────────────┘
```

7 个阶段。每一阶段的**产出物**和**判断 gate**都要明确,否则流程会变成一坨
没人遵守的 markdown。

---

## 阶段 1:Plan(设计 showcase)

### 产出物(必须)

每个 showcase 启动前,在 `showcases/<n>/PLAN.md` 写:

**1. 一句话场景描述**

> "一个 CLI 编码 agent,给定 GitHub issue,在 harness-one 自己的 repo 里
> 自主修改代码并跑测试直到通过,最多 50 轮迭代。"

注意:如果"一句话场景"对应的工程量是数月级别,这不是 showcase,是 app。
重新评估归属(见 `harness-one-form-coverage.md` 的"三层判断规则")。

**2. 形态定位(光谱坐标)**

从 9 种 agent 形态里选一个主形态 + 至多一个次形态。
**不允许"什么都是"**——那是设计懒惰。

**3. 压力点清单(Pressure Points)**

显式列出这个 showcase 对 harness 的核心压力点,每条要可观察:

- "AgentLoop 连续运行 50 轮不崩、状态机无泄漏"
- "CheckpointManager 在第 30 轮 crash 后能 resume 不丢进度"
- "shell tool 的 guardrail 拦住 `rm -rf` 类操作"
- "cost tracker 统计准确,误差 < 5%"

压力点数量目标:**8-15 条**。少于 8 条说明 showcase 不够挑战;
多于 15 条说明 scope 失控。

**4. 涉及的 subsystem 声明**

列出这个 showcase 会用到哪些 subsystem,分三类:

- **Primary**(主用):showcase 的核心压力在这些上
- **Secondary**(辅用):会用到但不是主角
- **Explicitly Avoided**(明确不用):标出来的目的是让你思考
  "为什么不用"——有时会发现 showcase 形态错了

**5. 可观察的成功标准(Observable Success Criteria)**

**不是主观的"跑得好"**,而是可断言的:

- 任务完成率:`X/Y tasks end with status=completed`
- 资源上限:`token usage < 100k per task`
- 时间上限:`average wall clock < 5min per task`
- 错误分布:`categorized errors match expected distribution`

至少有一条是**二元的 pass/fail**,否则你永远在纠结"够不够好"。

**6. 明确的非目标**

写出 showcase **不打算证明**的东西。比如长时编码 agent:

- 不证明 LLM 真的能解决复杂 bug(那是 LLM 能力问题,不是 harness 问题)
- 不证明 UX 很好(那是 CLI wrapper 的职责)
- 不证明 multi-tenant(这个 showcase 是单用户场景)

显式列出非目标,**就不会被中途拉偏**。

### Gate:Plan Review(哪怕是对自己)

PLAN.md 写完后,**过一遍以下 checklist**:

- 压力点是否每条都可观察?
- 成功标准是否有二元 pass/fail?
- 形态坐标是否单一?
- 非目标是否清晰?
- 压力点合起来是否 cover PLAN 里声明的 Primary subsystems?

过不了 review 就不进下一阶段。**这一步花 2 小时胜过最后重做 2 天**。

---

## 阶段 2:Hypothesis Freeze(冻结假设)

这是**最容易被跳过但最有价值**的一步。

### 做什么

在写任何代码之前,基于当前对 harness-one 的认知,**预测会发生什么**:

在 `showcases/<n>/HYPOTHESIS.md` 写:

**1. 期望顺利的地方**(标注:✅)

> "我预期 AgentLoop 状态转换完全 smooth,因为单测覆盖充分。"
> "我预期 cost tracker 数字准确,因为已经有集成测试。"

**2. 担心会出问题的地方**(标注:⚠️)

> "我担心 CheckpointManager 的 FileSystemStore index 在进程 crash 后
> 可能留下脏数据。"
> "我不确定 StreamAggregator 在 50+ 轮场景下内存是不是会持续增长。"

**3. 完全不知道会怎样的地方**(标注:❓)

> "不知道真实 Anthropic SDK 的 reasoning_tokens 字段对我的 TokenUsage
> 类型兼容不兼容。"

### 为什么重要

showcase 做完后会对比**假设 vs 实际**:

- ✅ 预期顺利 + 实际顺利 → 现有测试体系是有效的
- ✅ 预期顺利 + 实际挂了 → **这是最有价值的发现**,
  说明测试体系有盲区,必须补
- ⚠️ 担心有问题 + 实际真的有 → 直觉准,但说明你**明知道有坑没补**,
  应该已经补了
- ⚠️ 担心有问题 + 实际没问题 → 好消息,但要理解**为什么担心错了**,
  避免下次对自己的直觉失去校准
- ❓ 未知区域的结果 → 立刻补进知识库和测试

**不冻结假设,做完 showcase 就只是"做完了"**。冻结假设,做完 showcase
就是"校准了对自己系统的理解"。差别巨大。

### Gate:假设覆盖 PLAN.md 所有压力点

每条压力点必须在 HYPOTHESIS.md 里有对应预测。不允许模糊。

---

## 阶段 3:Build(搭建)

实现阶段。这阶段本身没太多流程可讲,但要遵守几条规则。

### 规则 1:只用 harness-one 公开 API

不允许 `import ... from 'harness-one/src/internal/...'` 抄近路。
**showcase 是用户视角,只能用用户能用的东西**。

违反一次,就说明 harness-one 公开 API 有缺口,立刻记到下面说的
FRICTION LOG 里。

### 规则 2:每绕过一次 harness,就记一笔

维护 `showcases/<n>/FRICTION_LOG.md`,**每次**你发现:

- 必须写额外胶水代码才能做到某事
- API 用起来别扭但能绕过去
- 某个 harness 功能没有,需要自己实现
- 错误信息看不懂,需要 read 源码才能诊断

立刻记一笔,**不要等做完再回忆**。具体到:

- 时间戳
- 卡住的具体点(文件 + 行号)
- 当前是怎么绕过的
- 初步判断:harness 要改还是 showcase 自己解决

这个文件后面是反哺阶段的核心输入。

### 规则 3:不追求产品级代码质量

showcase 是**实验代码**,不是 production。允许:

- 硬编码(但要有 `// TODO(showcase): parameterize this` 标记)
- 缺错误处理(但不能隐藏错误——要么 throw 要么 log)
- 只有一组测试数据(但要够真实)

不允许:

- 跳过 harness 的 budget / guardrail 设置(这是 dogfood 的核心)
- 关掉 observability(会让反哺阶段无米下锅)
- 用假 API key / mock 跑(实验意义在真实环境,cassette 只给 CI 用)

### 规则 4:always-on observability

每个 showcase 从第一行代码就:

- 接 traceManager,exporter 落文件或 console
- 接 costTracker,每轮打印
- 接 lifecycle,graceful shutdown handler
- `budget` 必须设(实验环境设紧一点,比如 $0.50)

这样才能在下一阶段有数据可分析。

### 规则 5:时间盒(Timebox)

| Showcase | MVP timebox |
|---|---|
| 01-streaming-cli | 1-2 天 |
| 02-rag-support-bot | 2-3 天 |
| 03-memory-checkpoint-stress | 2-3 天 |
| 04-orchestration-handoff | 2-3 天 |

注意:**这是 MVP timebox,不是完整 7 阶段 timebox**。完整 7 阶段(包含
Observe + Harvest + Feed Back + Archive)总投入约 5-10 天/showcase。

**超出 MVP timebox 就停手进入 Observe 阶段**,哪怕 showcase 不完整。
"做不完"本身就是信号。通常意味着 PLAN 阶段 scope 没控制好,
或者撞上了 harness 本身的坑——这两种情况都需要**现在就反哺**,
不是继续硬磕。

如果一个 showcase 反复超时盒(比如 ×3),重新评估它是否真的是 showcase
而不是 app(归属判断见 `harness-one-form-coverage.md`)。

---

## 阶段 4:Observe(真跑 + 观察)

做完搭建后,**至少跑 10 次真实 run**(用真 API key),记录每次结果。
不是 run 一次看见 "done" 事件就算通过。

### 必须采集的数据

**1. 量化指标**(每次 run)

- 任务是否完成(boolean)
- wall clock 时间
- token usage(input/output/cache,分开)
- cost(dollars)
- LLM 调用次数
- tool 调用次数
- 错误事件数及分类

**2. 质性观察**(每次 run,用日志/笔记)

- 哪几步是"我等了很久才看到下一个输出"?→ 可能是性能/体验问题
- 哪几步我不得不去看 trace 才知道发生了什么?→ 错误消息可能不够
- 哪几步我怀疑 harness 搞错了某件事?→ 立刻写下来,不要自我说服

**3. 系统性观察**(多次 run 合起来看)

- 同样输入下,行为稳定吗?
- cost 方差多大?
- 错误事件是偶然还是有 pattern?
- trace span 总数是否和预期相符?
- 任何 metric 在多次 run 间有 monotonic 趋势(可能是泄漏)?

### 产出物

`showcases/<n>/OBSERVATIONS.md`:把上面 3 类数据结构化记录。

格式建议:

```markdown
# OBSERVATIONS · <showcase name>

## Run summary

| Run # | Status | Wall clock | Tokens | Cost | Errors | Notes |
|---|---|---|---|---|---|---|
| 1 | ✓ | 38s | 5234 | $0.02 | 0 | first cold run |
| 2 | ✓ | 21s | 5102 | $0.02 | 0 | |
| 3 | ✗ | 95s | 11200 | $0.05 | 2 | rate-limit retry kicked in |
| ...

## Quantitative aggregates

- Completion rate: 9/10
- Median wall clock: 32s
- p95 wall clock: 58s
- ...

## Qualitative observations

### Run 3 anomaly (failure)
...

### Tool retry count grew between runs
...
```

### Gate:数据完整 + 至少 10 次 run

OBSERVATIONS.md 不达标 → 不进 Harvest。

---

## 阶段 5:Harvest(收割洞察)

把 OBSERVATIONS 跟 HYPOTHESIS 对照,产出 `showcases/<n>/HARVEST.md`。

### 产出物结构

```markdown
# HARVEST · <showcase name>

## 假设 vs 实际(2x2 矩阵)

|                  | 实际顺利 | 实际有问题 |
|------------------|---------|-----------|
| 预期顺利         | ✅ 验证  | 🚨 测试盲区(最有价值) |
| 担心有问题       | 直觉准  | ⚠️ 直觉错位 |

每个象限至少一条具体观察 + 来源(指向 OBSERVATIONS.md 哪一节)。

## 🚨 象限重点(测试盲区清单)

每条带:
- 现象
- 根因猜测
- 反哺动作(具体到 issue / PR / RFC)
- 优先级

## 直觉错位的反思

> 为什么我担心 X 却没事?
> 为什么我以为 Y 没事却挂了?

短反思,几行字够。但**必须写**——这是校准未来直觉的输入。
```

### Gate:每条压力点 + 每条假设都有对应象限归属

任何 HYPOTHESIS 里的预测在 HARVEST 里"无对应"——意味着观察不充分。
打回 Observe 重跑。

---

## 阶段 6:Feed Back(反哺)

HARVEST.md 不是终点,是行动起点。把每个 🚨 象限观察转换成具体动作。

### 反哺路径

**1. 真 bug → issue + PR**

> HARVEST 里每条"代码逻辑错"

直接开 issue + 提 PR。PR description 必须 link 回发现它的 showcase 和
specific observation。

**2. API 设计问题 → RFC 或 ADR**

> FRICTION_LOG 里每条"别扭但能绕过去"都是候选

- 超过 3 条相关 friction → 写一个 `docs/rfc/NNNN-<topic>.md`
- 讨论:是设计本来就对、文档不够?还是 API 需要改?
- 改动型的 RFC 进 ADR(`docs/adr/`)后执行

**3. 测试体系盲区 → 新增测试 + 更新测试策略**

- 每个 🚨 象限的 observation → 必须补测试
- 在测试策略文档里反映:哪一层缺了东西、补了什么
- 如果某类盲区反复出现,考虑是否整个层的做法要调整

**4. 文档缺陷 → 直接改**

- FRICTION_LOG 里每条"需要 read 源码才能解决"的 friction
  → 至少对应一条文档改动
- 考虑:这个知识**应该**在哪里?README? TSDoc? ADR? 新文档?
- 决定后直接改,不要积压

**5. 性能 / 资源问题 → perf baseline + 可能的优化**

- OBSERVATIONS 里性能 hotspot → 进 `tests/perf/` 作为 baseline
  (即使还没优化,先 lock 住 regression)
- 优化作为独立 PR,和 baseline 分开

**6. 未来 roadmap 线索 → `docs/ROADMAP.md`**

- 某些洞察不立刻处理,但不该忘
- 显式放进 roadmap,标上"发现自:showcase X"
- 防止好 idea 消失

### 反哺 PR 的规则

**每个反哺 PR 必须**:

- 在 description 里 link 回发现它的 showcase 和 specific observation
- 带**对应的失败用例**(先 red 再 green)
- 如果涉及 API 改动,更新 MIGRATION.md

这样 3 个月后回头看,**每个改动都能追溯到真实使用场景**,不是凭空想象。

### 产出物

`showcases/<n>/FEEDBACK.md`:

```markdown
# FEEDBACK · <showcase name>

## 已开 issue

- #234 — CheckpointManager fs index 错乱 (HARVEST 🚨 #1)
- #237 — shell tool guardrail 错误信息看不懂 (HARVEST ⚠️ #2)

## 已提 PR

- #245 — fix #234 同时加 chaos test

## 已写 RFC / ADR

- docs/rfc/0023-tool-error-formatting.md (来源:FRICTION_LOG #3, #5, #7)

## 进 roadmap

- ROADMAP.md 新增 "Multi-tenant retry budgets"(发现自本 showcase)

## 反哺前后对比

(可选)showcase 跑修复后再跑一遍,对比改动效果。
```

---

## 阶段 7:Archive & Regress(归档 + 回归防线)

showcase 做完反哺完之后,**不扔掉**。它要持续 earn its keep:

### 作为 CI 回归防线

- 把 showcase 的真实运行录成 cassette
- 在 CI 里用 cassette replay 跑 showcase
- 任何改动导致 showcase 跑不通 → 立刻发现

### 作为 Reference Example

- showcase 是给未来开源用户看的**最高保真度示例**
- 在仓库根 README 的 Showcases 章节列出
- 文档里提到"如何做 X"时 link 到对应 showcase

### 作为 DX Regression 检测器

- 每个 minor version 升级,重新在 showcase 上跑一遍
- 如果同样 code 在新版上跑不了 → 要么 breaking change 要文档化,
  要么修 bug

### 归档产出物结构

```
showcases/<n>/
├── PLAN.md              # 阶段 1 产出
├── HYPOTHESIS.md        # 阶段 2 产出,不删——是历史认知记录
├── FRICTION_LOG.md      # 阶段 3 累积
├── OBSERVATIONS.md      # 阶段 4 产出
├── HARVEST.md           # 阶段 5 产出
├── FEEDBACK.md          # 阶段 6 完成后,link 所有反哺 PR/issue/ADR
├── src/                 # 实现
├── cassettes/           # 真实运行录制
└── README.md            # 最后写,给外部读者用(以上文档是给内部过程的)
```

**PLAN / HYPOTHESIS / HARVEST 不删**。几个月后回头看很有意义——
你能看到自己对系统的认知是怎么演化的。

---

## 跨 Showcase 的协同机制

多个 showcase 不是彼此独立的,要形成系统性证据。

### 共享 FRICTION_LOG 汇总

维护 `docs/showcase-frictions.md`,每完成一个 showcase 后把所有 showcase
的 FRICTION_LOG 汇总:

- 出现 ≥2 次的 friction 类型 → 系统性问题,优先处理
- 只在某个 showcase 出现的 → 形态特异性问题,评估是否普适

### 压力点覆盖矩阵

`harness-one-form-coverage.md` 里有完整的 12 子系统 × 三层覆盖矩阵。
做完每个 showcase 后,核对该 showcase 实际压到的子系统跟 PLAN 声明的
Primary 是否一致。不一致 → 要么修矩阵,要么反思 showcase 设计。

### "假设对错"季度盘点

每季度回顾所有 HYPOTHESIS.md,统计:

- 预期顺利实际顺利率
- 预期担心实际出问题率
- 未知区域比例下降速度

**这几个数字就是你对 harness-one 理解准确度的量化指标**。
能看出:是不是对系统理解得越来越准?测试体系是不是在真的消除盲区?

跨 showcase 的盘点结果进 `docs/showcase-retro-<year>.md`。

---

## 失败模式清单

以下是执行这套流程时容易踩的坑,显式警示:

**失败模式 1:跳过 PLAN.md 直接开始写**

- 后果:做完才发现压力点没校准,要么验证不了想证明的,
  要么证明了不重要的
- 对策:PLAN.md 不完整不开始 build

**失败模式 2:HYPOTHESIS 写得太模糊**

- 错误例子:"我觉得大部分应该还好"
- 正确例子:"我预期 50 轮 iteration 后内存稳定在 < 50MB,
  因为 LRU cache 有 eviction"
- 对策:每条假设必须可被观察证伪

**失败模式 3:跑 1-2 次就宣布完成**

- 后果:偶发 bug 被忽略,系统性问题看不到
- 对策:至少 10 次 run,且要包含不同输入

**失败模式 4:Harvest 阶段自我开脱**

- 典型表现:"那个 bug 应该是 LLM 不稳定造成的,不是 harness 问题"
- 这种判断可能对,但**不能跳过 investigation 就下结论**
- 对策:每条 🚨 都要有证据链,不允许"应该是"

**失败模式 5:反哺阶段积压**

- 典型表现:observations 记了,没变成实际改动
- 对策:Harvest 完成后的下一周强制反哺,否则停止下一个 showcase

**失败模式 6:showcase 变成产品**

- 典型表现:花时间打磨 CLI 体验、加功能、优化 UX
- 这种冲动通常意味着 showcase 选错了——你想做的是 app
- 对策:严格 timebox,PLAN 里的非目标反复对照
- 如果反复触发这个失败模式,把项目从 showcases/ 移到 apps/

**失败模式 7:沉默的成功**

- 典型表现:showcase 跑通了,但没写 HARVEST、没反哺、没归档
- 后果:证据价值归零
- 对策:每个 showcase 都要完整跑完 7 个阶段才算完成

---

## 一个 showcase 的完整时间线预估

以 `01-streaming-cli`(最简单的)为例:

| 阶段 | 工时 | 产出 |
|---|---|---|
| Plan | 2 小时 | PLAN.md |
| Hypothesis Freeze | 1 小时 | HYPOTHESIS.md |
| Build | 1-2 天 | src/, FRICTION_LOG.md |
| Observe | 0.5 天(10+ runs) | OBSERVATIONS.md |
| Harvest | 半天 | HARVEST.md |
| Feed Back | 1-3 天(看发现量) | PRs, ADRs, tests, docs |
| Archive & Regress | 2 小时 | cassettes, README, CI 接入 |

**总计:约 5-7 个工作日**(全力投入)。

最复杂的 showcase(`02-rag-support-bot` 或 `03-memory-checkpoint-stress`)
可能 7-10 天。**注意:这跟选型文档原本估的"1-2 天 MVP"不冲突——MVP 是
Build 阶段产出,完整 7 阶段总投入更大**。

但产出是:

- 一个可持续跑的 showcase
- ~10-30 个具体的 harness 改进点(补 bug、改 API、加测试、改文档)
- 对 harness-one 理解的一次大幅校准
- 一份 CI 回归防线
- 跟 examples 互补的"高保真参考实现"

这个产出密度**远超**任何其他活动。

---

## 最简可执行版本(如果你要极度精简)

如果某个 showcase 因为各种原因不能完整跑 7 阶段——可以,但**不能砍这 4 件事**:

1. **写下假设,再开始做**(5 分钟事)
2. **做的过程记 friction**(边做边写)
3. **做完对比假设 vs 实际**(半小时事)
4. **把反哺变成 issue/PR**(不反哺 = 白做)

这 4 步是**不可压缩的最小集**。其他都可以视情况简化。

如果连这 4 步都跳,你做的不是 showcase,是 example——把它从 showcases/
移到 examples/。**价值不在代码本身,在围绕代码的思考流程**。

---

## 与 examples 和 apps 的接口

### 什么时候 example 应该升级成 showcase

- 已经写了一个 example,但发现"我其实想验证一些假设、想反哺主仓库"
- 这时把 example 从 `examples/` 移到 `showcases/<n>/src/`,补完 6 份 markdown
- 不要让 example 留在原位置同时双重身份

### 什么时候 showcase 应该升级成 app

- 完成 7 阶段后发现"这东西其实想长期跑、想 dogfood"
- 这时把 `showcases/<n>/src/` 的代码迁到 `apps/<name>/`
- showcases/<n>/ 目录保留(归档不动),apps/<name>/ 是新生命周期
- 在 apps/<name>/README.md 显式 link 回 showcase 历史

### showcase 的反哺产出 vs apps 的反哺产出

| | showcase | apps |
|---|---|---|
| 反哺触发 | 7 阶段 Harvest 集中产出 | HARNESS_LOG 持续累积 |
| 反哺周期 | 一次性,完成后归档 | 长期,跟着 app 生命周期 |
| 反哺信号 | 假设 vs 实际对比 | 长期运行 metrics |

详见 `harness-one-app-feedback-loop.md`。

---

## 结语

Showcase 工作流的本质是:**把隐性认知变成显性证据**。

你做 showcase 过程中产生的每一个"哎这里怎么这样"、"这个我没想到"、
"这里有点别扭"——这些**才是 showcase 的真正产出**,不是代码。
流程的作用就是保证这些认知不蒸发,而是沉淀成 issue / test / doc / ADR。

没有流程,showcase 做 10 个也是 10 次各自独立的摸索。
有流程,做 4 个就能让 harness-one 的可信度跳一个台阶——
因为每个 showcase 都在以可追溯的方式消除系统的不确定性。

这是从"做了很多事"到"积累了多少事"的分水岭。
