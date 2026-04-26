# harness-one 反哺自动化机制

> 本文档解释 `harness-one` 仓库里的 friction-logging 自动化是怎么工作的。
> **给人看**——给 contributor 理解这套机制存在的理由和工作方式。
>
> 实际操作给 Claude Code 看的指令在 `.claude/feedback-instructions.md`。
> 反哺机制本身的设计在 `docs/harness-one-app-feedback-loop.md`。

---

## TL;DR(给赶时间的人)

- 你日常用 Claude Code 写 `apps/*/` 或 `showcases/*/` 的代码时,Claude
  会**默默观察 friction 信号**(代码里的 workaround、对 harness-one 源
  码的 grep、你抱怨某 API 不顺手...)。
- 在 task 边界(你说"commit 了 / 搞定 / next")时,Claude **批次问你**
  哪些要记到 LOG。
- 你也可以随时显式 `/log-friction <description>` 强制记一条。
- 周期维护:`/triage-frictions`(每周)、`/sync-app-frictions`(每月)。
- **不会让你慢**——如果让你慢了,告诉维护者,立刻调灵敏度。

下面是细节。

---

## 为什么需要自动化

`harness-one-app-feedback-loop.md` 定义了 apps 反哺主仓库的标准流程:

```
开发遇到别扭 ─► HARNESS_LOG.md ─► triage ─► issue/PR/RFC ─► 主仓库改进
                  (per app)
```

这套流程**理论上**就够了——每次遇到 friction,人手动追加一条 LOG,就行。

**实际上**:人手动记 LOG 是反哺机制最脆弱的环节。

观察到的失败模式:

- Sprint 紧的时候,记 LOG 第一个被砍("先把代码搞定再说,LOG 等等再补")
- 几小时后,具体细节已经忘了,只记得"那 API 真烦",但不记得是哪个、
  什么场景、当时怎么绕过去的
- 一周后,根本想不起来今天遇到过 friction
- 如果记起来了,格式经常不一致(有时详细、有时一句话),后续 triage 困难

最终:**反哺密度逐渐衰减**,不是因为 harness-one 没问题了,而是因为人
记不动了。这跟 harness-one 三层架构里 apps 的核心定位(长期反哺)直接
冲突。

**自动化的核心目的**:让"记 LOG"从"需要人主动决定"变成"工具默认行为
+ 人确认/拒绝"。

---

## 机制如何工作

整套机制围绕 **Claude Code 作为 friction 抓手**设计,因为:

- 你日常用 Claude Code 写 harness-one 的 apps 和 showcases
- Claude Code 看得到完整对话上下文,有能力识别 friction 信号
- Claude Code 写文件的成本接近零,可以把"记 LOG"从负担变成顺手

### 三个组件

```
┌─────────────────────────────────────────────────────────────┐
│  CLAUDE.md                                                   │
│   └─► 引用 .claude/feedback-instructions.md                  │
└─────────────────────────────────────────────────────────────┘
                           │
              ┌────────────┴───────────┐
              ▼                        ▼
┌──────────────────────────┐  ┌────────────────────────────┐
│ Auto-detection           │  │ Slash commands             │
│ (Claude session 中默默    │  │ (用户显式触发)              │
│  累积候选 + 批次确认)      │  │                            │
│                          │  │  /log-friction <text>      │
│ 触发:                    │  │  /triage-frictions         │
│   - 用户直接信号(高置信)  │  │  /sync-app-frictions       │
│   - 代码 pattern 信号     │  │                            │
│   - workflow 信号         │  │                            │
└──────────────────────────┘  └────────────────────────────┘
              │                        │
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ Per-app HARNESS_LOG.md │
              │ + 跨 app 汇总           │
              │   docs/app-frictions.md│
              └────────────────────────┘
```

### 工作流的两种模式

**模式 1:被动批次模式**(最常见)

Claude Code 在你日常对话中,默默观察:

- 你说"这 API 真烦"——直接信号
- 你写了 `// HACK: ...` 注释——代码 pattern 信号
- 你 grep 了 harness-one 源码——workflow 信号

**不打断你**,默默累积候选 friction。

到了 task 边界(你说"OK 这就 commit 了" / "搞定" / "next"),Claude
一次性问你:

```
我注意到这次 session 有 3 条可能的 friction:
  1. createFallbackAdapter 的 onFailover hook 缺失
  2. ContextRelay 的 _version 字段处理不清
  3. ...

要记 1 / 2 / 3 / 全记 / 都不记?
```

你 yes/no 几条,Claude 写 LOG。

**模式 2:用户显式触发**(主动)

任何时候你可以:

```
/log-friction createFallbackAdapter 的 onFailover hook 缺失,我得在
fallback adapter 里手塞日志,有点别扭
```

跳过自动识别,直接走"起草 → 你确认 → 写入 LOG"。适合:

- 模式 1 漏掉了某条 friction(你回头想起)
- 你不在 task 边界但现在想立刻记
- 你想强制 Claude 记某条它没识别的事

### 周期性维护命令

除了实时记录,还有两个周期命令:

**`/triage-frictions`**(建议每周一次)

让 Claude 扫所有 HARNESS_LOG.md 里"待评估"状态的条目,提议每条该走什么
反哺路径:

- 真 bug → 起草 issue
- API ergonomic → 起草 RFC
- 文档缺陷 → 直接改文档
- 不需反哺 → 标记并说明

你 yes/no 后 Claude 执行 + 同步更新 LOG 文件的 checkbox。

**`/sync-app-frictions`**(建议每月一次)

让 Claude 识别在 ≥2 个 apps 出现的 friction 模式——这些是系统性问题,
更新 `docs/app-frictions.md`。

---

## 使用方法 / Quick Start

### 0. 前置确认(每个 contributor 第一次时)

仓库根有这些文件:

- `CLAUDE.md` —— 入口
- `.claude/feedback-instructions.md` —— Claude 的操作指令
- `.claude/commands/log-friction.md`, `triage-frictions.md`,
  `sync-app-frictions.md` —— slash commands

如果你看到 `.claude/feedback-instructions.md` **不存在**,说明本机的
`.gitignore` 配置有问题(默认这个文件应该被 track)。检查 `.gitignore`
里有没有这一段:

```gitignore
.claude/*
!.claude/feedback-instructions.md
!.claude/commands/
```

### 1. 日常工作流(被动模式,占 90%+ 场景)

**你不用做任何事**。在 `apps/*/` 或 `showcases/*/` 里写代码,Claude 自己
观察。

到了任务收尾时(commit / 切换任务 / "搞定了"),Claude 会主动 surface
本次 session 的 friction 候选,你 yes/no 即可。

```
> OK 这就 commit 了

[Claude]
稍等,在 commit 之前我想 surface 这次 session 的 friction 候选:

1. [signal-B] 你在 src/agent.ts:45 写了 `// workaround:
   harness-one 没暴露 retry budget`,这是想反哺吗?
2. [signal-C] 你 grep 了 packages/core/src/observe/trace.ts 才搞清
   spanId 生成规则。文档不够?

记 1 / 2 / 都记 / 都不记?

> 都记

[Claude]
已写入 apps/coding-agent/HARNESS_LOG.md(+2 条)。继续 commit。
```

### 2. 显式记一条

```
/log-friction createFallbackAdapter 没暴露 onFailover hook,得在 adapter
内部手塞 log,破坏接口对称性
```

Claude 起草 → 你确认 → 写入。3 步以内完成。

如果命令后什么都不写,Claude 会问你"要记什么 friction?把刚才提到的 X
记下来吗?"。

### 3. 周期 triage(建议每周一次)

```
/triage-frictions
```

Claude 会:

1. 扫所有 `apps/*/HARNESS_LOG.md` + `showcases/*/FRICTION_LOG.md`
2. 列出所有"待评估"状态的条目
3. 对每条提议具体动作(开 issue / 写 RFC / 加 ROADMAP / 标记不反哺)
4. 你选执行哪些
5. 执行 + 同步更新 LOG checkbox

如果一条都没有,会回"所有 friction 都 triage 过了 ✓"。

### 4. 跨 app 汇总(建议每月一次,或某个 app 完成 RETRO 后)

```
/sync-app-frictions
```

Claude 找在 ≥2 个 apps 出现的相同根因 friction,更新
`docs/app-frictions.md`(已存在)。

只有 1 个 app 时(早期阶段),会跳过并报告。

---

## 反哺机制的"灵敏度"调节

自动识别的 false positive / false negative 永远是问题。当前默认是
**中等灵敏度** + **批次确认**,基于这些判断:

- **高灵敏度**(每次都问)被否决:打扰太多,你最终会关掉这个机制
- **低灵敏度**(只显式触发)被否决:抓不到 60% 的 candidate friction
- **中等 + 批次**:对话中默默累积,在自然停顿点确认。打扰少,信号密度高

### 现场临时调整

跟 Claude 直接说:

- 太频繁 → "灵敏度调低,只记高置信的"
- 漏太多 → "灵敏度调高,你刚才应该 catch 到 X"
- 本次 session 完全不要 → "这个 session 跳过 friction logging"

调整只在当前 session 生效。

### 永久调整

改 `.claude/feedback-instructions.md`:

- §2 信号清单 — 删掉某些过敏感的代码 pattern signal,或加新信号
- §3 surfacing 时机 — 改"surface only at"条件
- §5 entry 格式 — 改 LOG 行格式

提交后所有 contributor 共享调整。

### 关闭整个机制

从 `CLAUDE.md` 删除"Feedback automation"章节即可——Claude 不再读
`.claude/feedback-instructions.md`,自动识别停止。slash commands 仍可
手动调用(它们直接读自己的 command 文件)。

---

## 跟 `harness-one-app-feedback-loop.md` 的关系

| 文档 | 受众 | 内容 |
|---|---|---|
| `docs/harness-one-app-feedback-loop.md` | 人 | 反哺**机制设计**:HARNESS_LOG 格式、RETRO 节奏、跨 app 汇总规则 |
| 本文档(`docs/harness-one-feedback-automation.md`) | 人 | **自动化层**如何运作:为什么、组件、工作流、使用 |
| `.claude/feedback-instructions.md` | Claude Code | **操作指令**:具体的信号识别、surface 时机、entry 格式 |
| `.claude/commands/*.md` | Claude Code | 各 slash command 的执行步骤 |

四层职责清晰:**机制设计 → 自动化设计 → Claude 操作指令 → 命令执行步骤**。

更新机制时只改第一层;改自动化策略改第二层;调 Claude 行为细节改第三
层;调单个命令的步骤改第四层。

---

## 故障排除

### "Claude 没主动记 friction"

- **可能原因 1**:它没读 `.claude/feedback-instructions.md`。检查
  `CLAUDE.md` 是否有引用 + 文件是否真的存在(`.gitignore` 排除问题?)
- **可能原因 2**:信号阈值不够。手动 `/log-friction` 几条,顺便提
  "你应该早点 catch 到这条",Claude 会调整灵敏度
- **可能原因 3**:你在的不是 `apps/*/` 或 `showcases/*/` 子目录,
  Claude 不确定该写哪个 LOG

### "Claude 记得太多,打扰频繁"

- 跟它说 "灵敏度调低 / 别每次都 surface"。它会调整
- 永久调整:改 `.claude/feedback-instructions.md` §2 的代码 pattern 信号
  清单,删掉过敏感的项

### "Claude 写的 entry 格式不对"

- 直接说 "格式不对,看 §5 的模板",它会重写
- 永久修复:改 `.claude/feedback-instructions.md` §5 的格式 spec

### "我不想要这套机制 in this session"

- 跟 Claude 说 "这个 session 跳过 friction logging"。它会停
- 永久关闭:从 `CLAUDE.md` 删除"Feedback automation"章节

### "`.claude/feedback-instructions.md` 在 git 里看不到"

- 检查 `.gitignore` 第 7-11 行:
  ```
  .claude/*
  !.claude/feedback-instructions.md
  !.claude/commands/
  ```
- 如果你曾经 commit 过 `.claude/`,可能要 `git rm --cached .claude/`
  再 add 回来

### "slash command 没反应"

- Claude Code 启动时会扫 `.claude/commands/*.md`。如果你刚拷文件进去,
  重启 session 试试
- 检查 command 文件 frontmatter `description:` 字段存在(影响发现)

---

## 评估机制效果

每个季度的 RETRO 阶段(参考 `docs/harness-one-app-feedback-loop.md` §3),
顺便回答:

- 本季度通过自动化记录的 friction 占总记录的 %?(目标 >70%)
- false positive 率(被你拒绝的)?(可接受 <30%)
- false negative 率(你回头补 `/log-friction` 的)?(可接受 <20%)
- triage 周期(从记录到处理动作的时间)?(目标 < 1 周)

如果几个数字趋势恶化,调整指令文件。

---

## 给新 contributor 的简短说明

如果你刚加入项目:

1. 仓库根有 `CLAUDE.md`,里面会引用 `.claude/feedback-instructions.md`
2. Claude Code 进入仓库时会自动读取
3. 你日常工作时,**不需要主动做什么**——Claude 会在合适时机问你
4. 想强制记一条:`/log-friction <description>`
5. 周期 triage:`/triage-frictions`(建议每周)
6. 跨 app 汇总:`/sync-app-frictions`(建议每月)

**这套机制不会让你慢**。如果它让你慢,告诉维护者,立刻调。

---

## 已知局限

### 1. Claude 看不到的 friction

如果你不通过 Claude Code 工作(直接 vim 改代码、跑 ad-hoc shell),那
次操作的 friction Claude 抓不到。补救:事后跑
`/log-friction <description>`。

### 2. Cross-session memory 局限

Claude Code 不跨 session 持久化 candidate friction。一个 session 没
surface 的 candidate 下次 session 不会自动 carry over。所以**及时在
task 边界确认**很重要。

### 3. Claude 判断错误时

Claude 可能误把"用户的代码 bug"当成 harness-one friction,或反过来。
这种情况就是 false positive,你拒绝即可。如果某类 false positive 反复
出现,改 `.claude/feedback-instructions.md` §2。

### 4. 这套机制只在 harness-one 仓库工作

不要把 `.claude/feedback-instructions.md` 复制到其他仓库——它的逻辑只对
harness-one 的反哺机制有意义,LOG 文件路径也是写死的。
