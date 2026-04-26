# harness-one 形态覆盖与项目分配

> 三层架构(examples / showcases / apps)的权威定义,以及 12 个子系统在
> 三层中的覆盖矩阵。本文档替代旧的 `harness-one-showcase-selection.md`。

---

## 三层架构:目的而非大小

harness-one 在仓库内有三类围绕主代码的产出物,**按目的分层,不按工程量分层**:

| 层 | 目的 | 服务对象 | 代表问题 |
|---|---|---|---|
| **examples/** | 学会用 | 未来的库使用者 | "我怎么用 createSecurePreset?" |
| **showcases/** | 校准库本身 | harness-one 维护者 | "这个形态下 harness 真的够用吗?" |
| **apps/** | 真实运行 | 项目本身 + dogfood 观察者 | "harness-one 在生产里真能扛多久?" |

**关键:三层的工程量可重叠,目的不重叠**。一个 200 行的 showcase 完全
可能,前提是它严格按 7 阶段方法论跑完 + 6 份产出物完整 + 真 API key 跑过 10 次。

---

## 三层判断规则(运维边界用)

未来添加新内容时,按以下规则决定放进哪一层:

### 放进 `examples/` 当且仅当

- ✅ 主要目的是给读者**学习如何用** harness-one 的 API
- ✅ 代码风格优先**可读性**,可以为可读性牺牲生产级 robustness
- ✅ 可以是单文件,也可以是子目录(如多文件 example)
- ✅ 完成后基本不再迭代,除非 API 变化要适配
- ✅ 不依赖真 API key(用 `harness-one/testing` 的 mock adapter)
- ✅ 在 `pnpm examples:smoke` CI 任务里能确定性跑过

### 放进 `showcases/` 当且仅当

- ✅ 主要目的是**发现 harness-one 的设计/实现/测试盲区**
- ✅ 严格按 [`harness-one-showcase-method.md`](./harness-one-showcase-method.md) 的 7 阶段流程
- ✅ 产出 6 份配套 markdown(PLAN/HYPOTHESIS/FRICTION_LOG/OBSERVATIONS/HARVEST/FEEDBACK)
- ✅ **用真 API key 跑过至少 10 次**,带 cassette
- ✅ 完成后 FRICTION_LOG 反哺主仓库,cassette 进 CI 当回归防线
- ✅ 大小不限——**重要的是流程完整,不是项目大**

### 放进 `apps/` 当且仅当

- ✅ 主要目的是**用 harness-one 完成实际任务**(triage、coding、research)
- ✅ 代码风格是生产级
- ✅ 至少满足以下之一:
   - **持续运行**(cron / GitHub Action / event 触发)
   - **持续维护**(对应规划中的 vertical package)
- ✅ 不要求按 7 阶段方法论(虽然方法论可借用)
- ✅ 维护标准化反哺产出物:`HARNESS_LOG.md` + `METRICS.md` + `RETRO/`
   (详见 [`harness-one-app-feedback-loop.md`](./harness-one-app-feedback-loop.md))

### 三层互斥决策树

```
新内容产出
  │
  ├─ 主要目的是教用法?
  │     └─ Yes → examples/
  │
  ├─ 主要目的是验证/发现 harness 的盲区?
  │     ├─ 能按 7 阶段跑完 + 6 份产出物?
  │     │     └─ Yes → showcases/
  │     └─ No(只能跑通,不能完成方法论)→ examples/
  │
  └─ 主要目的是完成业务任务?
        ├─ 持续运行 or 对应 vertical package?
        │     └─ Yes → apps/
        └─ No(只是一次性脚本)→ examples/
```

---

## 子系统覆盖矩阵

harness-one 有 12 个 L3 子系统(根据 `docs/00-overview.md`)。三层合起来
对每个子系统的覆盖必须保证至少一个"主压"位置。

### 当前 + 规划覆盖矩阵

✓ = 辅压(顺带覆盖) ✓✓ = 主压(独立验证)

| 子系统 | examples | showcases | apps | 主压所在层 |
|---|---|---|---|---|
| **core** | autoresearch-loop ✓ (fallback adapter) | 01-streaming-cli ✓ / 02-rag-support ✓ | dogfood / coding-agent / research-collab | 三层都压 |
| **prompt** | — | 02-rag-support ✓ | dogfood / coding-agent ✓ | apps(深度) |
| **context** | — | 02-rag-support ✓ (检索结果撑爆 context) | coding-agent ✓ / research-collab ✓ | apps(深度) |
| **tools** | — | 02-rag-support 轻 | dogfood ✓ / coding-agent ✓✓ | **apps(深度,coding-agent 主压)** |
| **guardrails** | codebase-qa ✓✓ | 02-rag-support ✓ | dogfood ✓ / coding-agent ✓ | **examples 主压(广度)+ apps 深** |
| **observe** | — | 01-streaming-cli ✓ (lifecycle) | 全部 | apps(长期) |
| **session** | — | 01-streaming-cli ✓ | coding-agent ✓ | showcase 主压 |
| **memory** | — | **03-memory-checkpoint-stress ✓✓** | coding-agent ✓ | **showcase 主压(短期)+ apps 深(长期)** |
| **rag** | codebase-qa ✓ | 02-rag-support ✓✓ | — | **showcase 主压** |
| **orchestration** | — | **04-orchestration-handoff ✓✓** | research-collab ✓ | **showcase 主压(短期)+ apps 深(长期)** |
| **evolve-check** | evolve-check-demo ✓✓ | — | dogfood 间接 | **examples 主压** |
| **advanced** | autoresearch-loop ✓ (fallback, backoff) | 01-streaming-cli ✓ (SSE) | coding-agent ✓ | 三层都压 |

### 矩阵成立的关键约束

1. **每个子系统都有至少一个 ✓✓ 主压位置**——没有"无人验证"的子系统
2. **`memory` 和 `orchestration` 短期靠 showcases 兜底**——避免 apps 拖延期间出现验证空窗
3. **`tools` 主要靠 apps 深度压**——因为 tool registry + capability allowlist 的真实压力只有在长链路 agent(coding-agent)上才显现

---

## 项目分配总表

selection 文档原本预设 4 个 showcase 覆盖一切,现按真实工程量分配到三层:

### showcases/ 层(4 个)

| # | 项目 | 工程量(MVP) | 7 阶段总投入 | 主压子系统 |
|---|---|---|---|---|
| 01 | streaming-cli | 1-2 天 | 5-7 天 | core (streaming) + advanced (SSE) + session + observe (lifecycle) |
| 02 | rag-support-bot | 2-3 天 | 7-10 天 | rag + context + prompt + guardrails |
| 03 | memory-checkpoint-stress | 2-3 天 | 7-10 天 | memory(独占,CheckpointManager + ContextRelay) |
| 04 | orchestration-handoff | 2-3 天 | 7-10 天 | orchestration(独占基础语义) |

**首批 4 个合计 7-11 天 MVP,完整 7 阶段约 4-5 周**。每个 showcase 详细 PLAN
见 `docs/showcase-plans/`。

### apps/ 层(3 个,其中 1 个已存)

| 项目 | 状态 | 工程量 | 主压子系统(深度) |
|---|---|---|---|
| dogfood | 已在跑 | (已完成) | preset + tools + guardrails |
| coding-agent | planned | 数月级别 | tools + memory(深度)+ advanced + 几乎所有 L3 |
| research-collab | planned | 1-2 周 MVP | orchestration(深度)+ core 多实例 |

详细设计见 `docs/app-designs/`。

### examples/ 层(3 个,已有)

迁移后保留:

- `examples/codebase-qa.ts`
- `examples/autoresearch-loop.ts`
- `examples/evolve-check-demo.ts`

允许将来追加,但不强制按数量目标。详见 `docs/examples-fix-plan.md`(对现存 3 个的修改方案)。

---

## 形态光谱与项目映射

按 selection 文档原本的 9 种 agent 形态光谱,看新分配是否合理:

| Agent 形态 | 代表产品 | 在 harness-one 落地 |
|---|---|---|
| 单轮 Q&A + RAG | 客服机器人 | showcases/02-rag-support-bot |
| 多轮对话 | ChatGPT-style | (未单独覆盖,coding-agent 多轮深压) |
| 工具密集型 | Perplexity | (apps/coding-agent 部分覆盖) |
| 长时运行 / 自主循环 | Claude Code | **apps/coding-agent** |
| 多 agent 协作 | CrewAI-style | **apps/research-collab + showcases/04-orchestration-handoff** |
| 流式交互 | Cursor chat | showcases/01-streaming-cli |
| 批处理 / 工作流 | bulk classification | (chaos test 覆盖,不单做 showcase) |
| 约束满足 / loop until pass | Generator-Evaluator | examples/autoresearch-loop |
| Agentic code | Aider, Cline | **apps/coding-agent** |

**未单独覆盖的形态**:

- "多轮对话" 这个形态的独立压测,通过 `apps/coding-agent` 的 long-running 多轮间接覆盖。如果将来发现需要单独做,可以加 `examples/multi-turn-chat.ts`(轻量)
- "批处理" 形态归到 chaos test 层(`packages/core/tests/chaos/`),不上 showcase

---

## 反哺路径概要

三层各自的反哺机制不同,但**所有反哺最终都进同一个目标**:让 harness-one 主仓库变得更对。

| 层 | 反哺触发 | 反哺产出形式 | 反哺频率 |
|---|---|---|---|
| examples | 写代码或读代码反馈 | issue / PR | 偶发 |
| showcases | 7 阶段执行期间 | FRICTION_LOG → HARVEST → 反哺 PR 包 | 一次性密集 |
| apps | 持续运行 + 维护 | HARNESS_LOG.md(累积)+ RETRO(周期) | 长期累积 |

跨层反哺汇总:

- `docs/showcase-frictions.md` (每完成一个 showcase 后更新)
- `docs/app-frictions.md` (每完成一个 RETRO 后更新,识别 ≥2 个 app 中的交叉问题)

详细机制:[`harness-one-showcase-method.md`](./harness-one-showcase-method.md)
和 [`harness-one-app-feedback-loop.md`](./harness-one-app-feedback-loop.md)。

---

## 历史决策记录

记录从 `harness-one-showcase-selection.md` v1 到本文档的关键转变:

### 转变 1:showcase 不再背所有覆盖

- **原**:4 个 showcase 合起来覆盖 12 个子系统(单层负担)
- **现**:三层共同覆盖,showcases 只承担"流程完整可校准"那部分(分层负担)

### 转变 2:长时编码 agent 是 app,不是 showcase

- **原**:selection 文档把"长时编码 agent"列为 ⭐⭐⭐⭐⭐ 必选 showcase
- **现**:它的真实工程量(数月)让它本质上是 app。**showcase 不是"大型项目"的同义词**,而是"严格按 7 阶段执行的形态实验"
- **影响**:`harness-one-coding` 包规划 = `apps/coding-agent/`,二者合一

### 转变 3:多 agent 协作主要由 app 承担

- **原**:多 agent 协作是 showcase #3
- **现**:apps/research-collab/ 是真实负载,showcases/04-orchestration-handoff 是基础语义聚焦
- **理由**:多 agent 真实压测需要长链路才能暴露问题,这只能 app 形态做

### 转变 4:新增 memory 和 orchestration 聚焦 showcase

- **原**:memory 子系统的形态级压测要等长时编码 agent(showcase #2)做完
- **现**:`03-memory-checkpoint-stress` 独立 showcase,**与 memory stress test 骨架合并**
   - 这条转变跟 memory 里 "crash recovery for FsMemoryStore" 优先项合并:
     stress test 以 showcase 形态产出,一份工时两份收益

### 转变 5:工时估算改保守

- **原**:selection 文档估"长时编码 agent 3-5 天 MVP"
- **现**:承认这是低估。coding-agent 数月级别,research-collab 1-2 周。
   **showcase 1-2 天 MVP 估算只对真正 showcase 范围内的项目成立**

---

## 验收标准

任何 PR 增加 `examples/` / `showcases/` / `apps/` 内容时,reviewer 用以下
checklist:

- [ ] 选择的层符合"三层判断规则"
- [ ] 不存在层级混淆(如把 examples 写成需要真 API 的形态实验)
- [ ] 子系统覆盖矩阵被本 PR 影响时,矩阵已同步更新
- [ ] 如果新增 showcase,7 阶段产出物完整(6 份 markdown + cassette)
- [ ] 如果新增 app,反哺机制产出物完整(HARNESS_LOG / METRICS / RETRO 至少占位)
- [ ] 项目根 README 的对应章节已更新
- [ ] 各层 README 索引已更新

---

## 与 vertical package 规划的对应

memory 里规划过的 `harness-one-coding` 包,在本架构下的处置:

```
apps/coding-agent/        ← 开发主仓库,dogfood 它自己
  src/
  package.json            ← 这是 npm 包的 manifest
  ...

# 发布时
pnpm changeset publish
# → npm: harness-one-coding@x.y.z
```

**app 目录就是 vertical package 的开发位置**,不是两套东西。Phase 5 之前
讨论过的"包和 app 分离"路径(packages/harness-one-coding + apps/coding-agent
各一份)被否决,因为:

- 等于把"实现"和"自用"放两个地方,违反 dogfood 原则(自己的 vertical package 应该自己 first 用户)
- 维护成本翻倍

未来如果某 app 演化出**真正独立**的 vertical package(代码不在 app 里),
再调整。当前所有 app 默认采用"app 即包"模式。

---

## 文档间引用关系

```
form-coverage.md (本文)
   │
   ├─ 引用 → showcase-method.md (showcase 的 7 阶段方法论)
   ├─ 引用 → app-feedback-loop.md (apps 的反哺机制)
   ├─ 引用 → showcase-plans/*.md (4 个 showcase 的 PLAN 起点)
   └─ 引用 → app-designs/*.md (2 个新 app 的设计)
```

主仓库 README 的 "Examples / Showcases / Apps" 三节并列引用本文。
