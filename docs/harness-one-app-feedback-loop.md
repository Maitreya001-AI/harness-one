# harness-one App 反哺机制

> apps/ 目录下项目向 harness-one 主仓库反馈信号的标准化机制。
> 与 `harness-one-showcase-method.md` 平级,是反哺体系的两个支柱之一。

---

## 为什么 apps 需要专门的反哺机制

apps 跟 showcases 反哺方式不同。

**showcases 反哺**:一次性密集,7 阶段做完产出 6 份 markdown,完事归档。

**apps 反哺**:长期累积,每天/每周/每月持续产生信号,never 归档(只要 app
还在运行)。

如果不给 apps 设计专门机制,实际后果是:

- apps 维护者口头说"会反馈到主仓库",但没记录就没记忆,3 个月后忘掉
- 同样的 friction 在多个 apps 重复出现,但没人发现这是系统性问题
- apps 跑出的真实运行数据不进 harness-one 主仓库的视野
- apps 演化出"自己跑自己的"孤岛文化

apps 反哺机制的目的:**让 apps 的长期运行真的转化为 harness-one 主仓库的
持续改进**。

---

## 反哺产出物三件套

每个 app 必须维护:

```
apps/<name>/
  HARNESS_LOG.md    # 持续累积的 friction 日志(每次开发/运维追加)
  METRICS.md        # 运行 metrics 累积或 dashboard 链接
  RETRO/
    YYYY-Q<N>.md    # 周期性回顾(每月或每季度)
```

加上跨 app 汇总:

```
docs/
  app-frictions.md  # 跨 app 的高频 friction 汇总(出现 ≥2 个 app 的)
```

下面逐一讲清楚每件产出物的目的、格式、维护节奏。

---

## 1. HARNESS_LOG.md(持续 friction 日志)

### 目的

记录**每一次**在 app 开发或运维过程中遇到 harness-one 别扭的瞬间。

跟 showcase 的 FRICTION_LOG 区别:

- showcase 的 FRICTION_LOG 是 7 阶段第 3 阶段产出物,完成后归档不动
- app 的 HARNESS_LOG 是**永远在累积**,跟着 app 生命周期走

### 触发条件(什么时候追加)

任何下列情况:

- 写代码时发现 harness-one 某个 API 别扭,但能绕过去
- 出 bug 时发现 harness-one 错误信息看不懂,需要读源码诊断
- 想做某事但 harness-one 没提供,自己写了胶水代码
- 文档说"应该这样用",但实际不行
- 升级 harness-one 后某行代码突然挂了

**关键:不止"上线遇到问题"才记**。开发过程中的小别扭也记。

### 格式

```markdown
# <App Name> Harness Log

> 持续累积的 friction 日志。每次开发/运维 <app> 时,如果遇到
> harness-one API 别扭、文档不够、错误信息看不懂、需要绕过去等情况,
> 在此追加一条。新条目添加在顶部。

---

## YYYY-MM-DD — <一句话标题>

**遇到的 friction**:具体哪个 API、哪种使用场景、遇到什么问题。
最好带一段最小复现代码。

**当前规避**:目前是怎么绕过的。
```ts
// 当前写法
const x = harnessOneApi(args)
  .pipe(workaroundFn)  // ← 这是绕过去的胶水
```

**反哺动作**:

- [ ] 已开 issue #XXX
- [ ] 已提 PR #XXX
- [ ] 已写 RFC docs/rfc/NNNN-xxx.md
- [ ] 待评估(根因还没想清楚)
- [x] 不反哺(理由:...)

**优先级**:低 / 中 / 高

**根因猜测**(可选):我认为这个问题的根因是 ...

---

## YYYY-MM-DD — <下一条>

...
```

### 维护节奏

- **每条 friction 立即追加**(不要"周末统一整理"——会忘)
- 至少**每周一次** triage:把"待评估"状态推进
- **每季度** 在 RETRO 里做一次系统性回顾

### 反例:不要写成"日记"

错误示范:

```markdown
## 2026-04-15
今天调试了一下午,发现 harness-one 真坑。后来终于搞定了。

## 2026-04-16
继续修。心累。
```

这种条目反哺价值为零。**没有具体 API、没有复现、没有动作**——3 个月后
看不知道当时遇到了什么。

正确示范:

```markdown
## 2026-04-15 — CheckpointManager fs index 错乱

**遇到的 friction**:在 coding-agent 跑到第 30 轮迭代时,进程被 OS 强杀
(OOM),重启后 CheckpointManager 加载 index 报 `STORE_CORRUPTION`。
最小复现:

```ts
const cm = createCheckpointManager({ store: createFileSystemStore({ dir: 'checkpoints' }) });
// ... 跑 30 轮 ...
process.kill(process.pid, 'SIGKILL');
// 重启后 cm.load() 抛 STORE_CORRUPTION
```

**当前规避**:每 5 轮强制 `cm.flush()`,缩小 crash 窗口。仍然不能根治
跨 5 轮的 crash。

**反哺动作**:

- [x] 已开 issue #234
- [ ] 已提 PR #(待 PR)

**优先级**:高(coding-agent 跑长任务时有 ~3% 概率触发)

**根因猜测**:`_index.json` 的 write 不是原子的。同事提到 `fs.rename`
原子性可以解决,但还没验证。
```

---

## 2. METRICS.md(运行指标)

### 目的

让 app 的运行数据**可被引用**到 RETRO、reports、和主仓库。

### 内容

简短,链接为主——大部分 metrics 数据应在外部 dashboard 里,
METRICS.md 只是入口。

```markdown
# <App Name> Metrics

## 数据源

- 运行报告:`./<app>-reports/`(repo 内累积)
- (可选)外部 dashboard 链接:[Langfuse](https://...) / [Grafana](https://...)
- (可选)cost dashboard:[Anthropic Console](https://...)

## 关键指标(滚动 30 天)

| 指标 | 当前 | 上月 | 趋势 |
|---|---|---|---|
| 触发次数 | 47 | 32 | ↑ |
| 平均每次 token 数 | 12,400 | 11,800 | ↑ slight |
| 成功率 | 89% | 92% | ↓ |
| 平均 wall clock | 2m 14s | 2m 02s | ↑ slight |
| 总成本 | $4.72 | $3.10 | ↑ |

**注**:成功率下降 3% 已记录到 HARNESS_LOG #2026-04-15。

## 异常历史

- 2026-03-22:OOM 导致 coding-agent 中止,触发 HARNESS_LOG #2026-03-22 反哺
- 2026-04-10:rate-limit 故障 → fallback adapter 生效,验证 fallback 配置正确
```

### 维护节奏

- 关键指标表格**每月更新一次**
- 异常历史**每次发生立即追加**

---

## 3. RETRO/<period>.md(周期性回顾)

### 目的

把 HARNESS_LOG 和 METRICS 的散点数据**结构化**成对主仓库的影响报告。

### 节奏

推荐**每季度一次**(coding-agent / research-collab),或**每月一次**
(dogfood,因为运行频率高数据多)。

### 格式

```markdown
# YYYY-Q<N> Retro · <App Name>

## 本期运行情况

- 触发次数:N
- 成功完成:N(M%)
- 异常:N
- 总 token 消耗:N
- 总成本:$X

## 高频 friction(从 HARNESS_LOG 提取)

按出现频率/严重度排:

1. **CheckpointManager fs index 错乱**(HARNESS_LOG 4 条)
   - 已修复 PR #245
   - 修复后 0 复现
2. **shell tool 错误信息不足**(HARNESS_LOG 2 条)
   - RFC docs/rfc/0023 中
3. ...

## metrics 观察

### 趋势

- 成功率从 92% → 89%,主要原因是 ...
- 平均 token 数稳定上升,跟 ... 有关

### 异常

- 2026-03-22 OOM: ...
- 2026-04-10 rate-limit: ...

## 对 harness-one 的影响

本期由 <app> 触发的反哺:

- **issue 开了**:#234, #237, #241
- **PR 提了/合了**:#245(已合), #248(review 中)
- **ADR/RFC**:RFC 0023 起草中
- **直接修文档**:docs/architecture/08-memory.md(checkpoint 章节)

## 给主仓库的建议

(具体的 API / 测试 / 文档建议,可能不在本期完成,放进 ROADMAP)

- 建议 1: ...
- 建议 2: ...

## 下期关注重点

- 验证 PR #245 修复在生产环境是否真的解决问题
- 探索 ...

## 跨 app 信号

(可选)本期 friction 跟其他 app 的 HARNESS_LOG 对照,看有没有交叉:

- HARNESS_LOG #2026-03-22 (OOM) 跟 dogfood 的 HARNESS_LOG #2026-02-08 是
  同一个 root cause → 已加入 docs/app-frictions.md
```

### Gate

每份 RETRO **必须**包含:

- "对 harness-one 的影响"章节,且至少 1 个 issue/PR/ADR/doc 改动 link
- 如果本期真的没产生反哺,要在该章节明确说明:
  > "本期 ZERO 反哺。原因:harness-one 在本期 app 使用范围内表现稳定,
  > 无 friction 触发。HARNESS_LOG 也无新条目。"
  
  **这是允许的**——但必须显式声明,不能默认。否则 reviewer 会以为
  "忘了写"。

---

## 4. docs/app-frictions.md(跨 app 汇总)

### 目的

识别**跨 app 重复出现**的 friction——这些是系统性问题,优先级最高。

只在某一个 app 出现的 friction,写在该 app 的 HARNESS_LOG 就够了。
出现在 ≥2 个 app 的,提升到 docs/app-frictions.md 跟踪。

### 格式

```markdown
# Cross-App Friction Summary

> 本文档汇总在 ≥2 个 apps 中出现的 friction。这些是系统性问题。
> 维护节奏:每个 app 完成 RETRO 后,扫一遍其他 apps 的 HARNESS_LOG
> 寻找交叉。

---

## Active(尚未根治)

### CheckpointManager fs index 错乱

- 出现于:`apps/coding-agent/HARNESS_LOG.md` (3 条) + `apps/dogfood/HARNESS_LOG.md` (1 条)
- 第一次报告:2026-02-08
- 当前状态:PR #245 已合并,观察中
- 跟踪 issue:#234

### shell tool 错误信息不足

- 出现于:`apps/coding-agent/HARNESS_LOG.md` (2 条) + `apps/dogfood/HARNESS_LOG.md` (1 条)
- 第一次报告:2026-03-15
- 当前状态:RFC docs/rfc/0023 起草中
- 跟踪 issue:#237

---

## Resolved(已根治,留作历史)

(空,等第一个 active 项目根治后移过来)

---

## 维护节奏

每完成一份 RETRO 后:

1. 浏览本期所有 RETRO 提到的反哺动作
2. 跟其他 apps 的 HARNESS_LOG 对照
3. 出现 ≥2 个 app 的 → 提升到 Active 章节
4. PR 合并 + 1 月观察期 + 0 复现 → 转 Resolved
```

---

## 反哺路径全图

```
                   ┌─────────────────┐
开发遇到别扭 ──────►│ HARNESS_LOG.md  │
                   │   (per app)     │
                   └────────┬────────┘
                            │
                  每周 triage / 月度看
                            │
                            ▼
                   ┌─────────────────┐
                   │  开 issue / PR  │
                   │   写 RFC / ADR  │
                   └────────┬────────┘
                            │
                            ▼
              ┌─────────────────────────┐
每季度 ──────►│  RETRO/<period>.md      │
              │   (per app, 结构化)      │
              └────────────┬────────────┘
                           │
                  跨 app 扫一遍
                           │
                           ▼
              ┌─────────────────────────┐
              │  docs/app-frictions.md  │
              │   (cross-app, 系统性)    │
              └────────────┬────────────┘
                           │
                  系统性问题进 ROADMAP
                           │
                           ▼
                   harness-one 主仓库改进
```

---

## 跟 showcase 反哺的对照

| | showcase 反哺 | app 反哺 |
|---|---|---|
| 触发 | 7 阶段 Harvest 阶段集中产出 | HARNESS_LOG 持续累积 |
| 周期 | 一次性,完成后归档 | 长期,跟着 app 生命周期 |
| 信号强度 | 短期密集,假设 vs 实际对比清晰 | 长期累积,运行 metrics 真实 |
| 适合发现的问题 | 设计级、API 设计盲区、测试体系盲区 | 长期 robustness 问题、scale 后才显现的 bug、UX 问题 |
| 产出物 | 6 份 markdown(PLAN/HYPOTHESIS/...) | 3 件套(LOG/METRICS/RETRO) |
| 反哺 PR 引用 | "发现自 showcase #N OBSERVATION X" | "发现自 app/<name> HARNESS_LOG entry YYYY-MM-DD" |

两种机制**互补不重叠**。同一个 bug 既可以被 showcase 发现也可以被 app
发现——但**触发路径和验证路径不同**,是好事。

---

## 失败模式清单

执行 app 反哺机制时容易踩的坑:

**失败模式 1:HARNESS_LOG 留空**

- 表现:运行 3 个月,LOG 一条都没有
- 不一定是问题(可能 harness 真稳),但**需要主动声明**
  > "本期未观察到 friction。已主动检查 X、Y、Z 等高风险路径。"
- 不写明的话,reviewer 无法分辨"真没问题"和"懒得记"

**失败模式 2:HARNESS_LOG 写成"开发日记"**

- 表现:条目里只有抱怨没有具体 API/复现/动作
- 对策:严格按格式,缺一项就把条目打回重写

**失败模式 3:RETRO 没"对主仓库的影响"章节**

- 表现:report 写得很好,但跟主仓库脱节
- 对策:Gate——没有 issue/PR/ADR link 的 RETRO 不算完成

**失败模式 4:跨 app 汇总没人维护**

- 表现:docs/app-frictions.md 长期空白,系统性问题被埋
- 对策:每份 RETRO 完成后 reviewer 强制扫一遍其他 HARNESS_LOG

**失败模式 5:反哺 PR 不引用来源**

- 表现:PR 说"修了 X bug",但没说"来自 app/<name> LOG entry"
- 对策:模板规定 PR description 必须 link 来源

---

## 给现存 dogfood 的回填指南

dogfood 已经在跑,反哺机制现在标准化。回填步骤:

### Step 1:回顾过去几个月的 dogfood 历史

打开 `dogfood-reports/`,过一遍报告,问自己:

- 哪些次运行让我修了 harness-one 主仓库的代码?
- 哪些次运行让我开了 issue / PR?
- 哪些 friction 当时记着了但没正式追踪?

把这些回填到 `apps/dogfood/HARNESS_LOG.md`,日期用真实发生日期,
不是回填日期。

### Step 2:写第一份 RETRO

写 `apps/dogfood/RETRO/2026-Q2.md`(或当前季度)。

如果回填的 LOG 跨多个季度,可以写一份 `apps/dogfood/RETRO/inception.md`
作为汇总:

> "dogfood 运行 N 个月,反哺机制 2026-Q2 标准化。本文档汇总 2026-Q2 之前
> 的反哺历史,作为 baseline。从 2026-Q3 起按季度正式 retro。"

### Step 3:METRICS.md 链接到 dogfood-reports/

最简起步:

```markdown
## 数据源

- 运行报告:`./dogfood-reports/`(每次触发产出一份)

## 关键指标

(待第一次 RETRO 时填入)
```

### Step 4:养成反哺习惯

最重要的一步,也最难。建议:

- 每次维护 dogfood 代码 / 修 dogfood bug 时,问自己"这个根因在 harness-one 那边吗?"
- 每周一抽 15 分钟扫一遍上周 dogfood 的运行,有没有"看着不对"的地方
- 每月看 METRICS,跟上月对比异常

---

## 给未来新 app 的初始化清单

新建 `apps/<foo>/` 时:

```bash
mkdir -p apps/foo/RETRO
touch apps/foo/HARNESS_LOG.md
touch apps/foo/METRICS.md
touch apps/foo/RETRO/.gitkeep
```

**起步内容**:

`apps/foo/HARNESS_LOG.md`:

```markdown
# foo Harness Log

> 持续累积的 friction 日志。新条目添加在顶部。

---

(尚无条目。第一条 friction 出现时按下方模板追加。)

---

## 模板

## YYYY-MM-DD — 一句话标题

**遇到的 friction**: ...
**当前规避**: ...
**反哺动作**:
- [ ] issue #
- [ ] PR #
**优先级**:低 / 中 / 高
```

`apps/foo/METRICS.md`:

```markdown
# foo Metrics

## 数据源

(待 app 上线后填入)

## 关键指标

(待 app 上线 30 天后填入)
```

**README 列表更新**:把 foo 加到 `apps/README.md` 的表格里。

---

## 跟 ROADMAP 的接口

apps 反哺机制产生的洞察,**长期价值**通过 `docs/ROADMAP.md` 沉淀:

- 立刻能修的 → issue/PR
- 设计级、需要讨论 → RFC/ADR
- 短期不修但不该忘 → ROADMAP

`docs/app-frictions.md` 里的 Active 项目,如果短期不能根治,**必须**
进 ROADMAP,标注"来源:apps/<name>"。

ROADMAP 维护节奏:每季度跟着 RETRO 一起更新。

---

## 总结

apps 反哺机制的核心价值:

1. **让 apps 的长期运行真的转化为主仓库改进**
2. **建立跨 app 系统性问题的识别路径**
3. **让 dogfood 不再是孤岛,coding-agent / research-collab 启动时就有现成路径**
4. **跟 showcase 反哺机制互补,覆盖"短期密集"和"长期累积"两种信号**

机制本身的代价:

- 每个 app 多 3 件产出物(LOG/METRICS/RETRO)
- 每季度多一次 RETRO 写作(每个 app 0.5-1 天)
- 跨 app 汇总维护(每季度 1-2 小时)

合计每个 app 每季度约 1 个工作日的反哺成本——对应保住"app 的运行价值不
浪费"的收益,绝对划算。
