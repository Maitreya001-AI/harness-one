# Track F · ADR（Architecture Decision Records）（P0）

**预估工时**：0.5 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-F -b testing/track-F-adr main
cd ../harness-one-track-F
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-F-adr`）。harness-one 是 TypeScript agent infra 库，架构文档在 `docs/architecture/00-overview.md` 起。

**任务**：写 5-10 条 ADR（Architecture Decision Record），把关键设计决策固化为可查证的历史记录。这是开源项目专业度最强的单一信号。

### 先读（必做）

```bash
ls docs/architecture/
cat docs/architecture/00-overview.md
cat docs/ARCHITECTURE.md | head -200
grep -rn "ADR\|decision" docs/ 2>/dev/null | head -20
cat MIGRATION.md | head -80
```

### 任务清单

#### F0 · 建立 ADR 目录和模板
- 新建 `docs/adr/0000-adr-template.md`（MADR 格式或 Nygard 风格，任选其一但要声明）
- 新建 `docs/adr/README.md` 说明 ADR 流程（什么时候写、怎么编号、status 流转 proposed/accepted/deprecated/superseded）

#### F1–F10 · 10 条 ADR（每条 ≤ 150 行）

每条 ADR 包含：
- **Status**（Accepted / Proposed / Superseded）
- **Context**（当时面临什么问题）
- **Decision**（选了什么方案）
- **Alternatives considered**（拒绝了什么，为什么）
- **Consequences**（正面 + 负面，诚实写）

建议主题（按需合并/拆分，目标 5-10 条）：

1. **ADR-0001 · 为什么不使用 graph DSL**
   - 拒绝 LangGraph 风格的 DAG / StateGraph
   - 选择：显式 loop + message-passing + hook 点
   - Why: 可调试性、learning curve、避免隐式控制流

2. **ADR-0002 · L3 子系统之间为什么不互相 import**
   - `core` / `prompt` / `context` / `tools` / `guardrails` / `observe` / `session` / `memory` 各自 closed，靠 hook / port / event 交互
   - Why: tree-shaking、可替换性、测试边界

3. **ADR-0003 · 为什么用工厂函数而非 class**
   - `createAgentLoop`、`createHarness` 而非 `new AgentLoop()`
   - Why: closure-based 私有状态、更易 functional compose、TS discriminated narrowing

4. **ADR-0004 · 为什么 `@harness-one/core` zero runtime deps**
   - Why: bundle size、供应链、audit 表面、长期维护成本

5. **ADR-0005 · trace/cost/token 三者口径统一**
   - 为什么一次 run 的 span 数、cost、token 必须同步可核对
   - 实现：`CostTracker` 绑定 `traceManager` 的 span lifecycle

6. **ADR-0006 · Guardrail 默认 fail-closed**
   - `createSecurePreset` 的默认 `failClosed: true`
   - Why: 安全语义（错过一次审查 vs. 错过一次拒绝）

7. **ADR-0007 · `TrustedSystemMessage` branded type**
   - 为什么用 brand + 工厂封装而不是 `as SystemMessage`
   - Why: 防止用户拼接用户输入到 system prompt、ID 混用

8. **ADR-0008 · Adapter 契约测试而非 mock-based 单测**
   - 每个 adapter 必须跑同一套契约 suite
   - Why: 接口语义偏移是 adapter 头号 bug

9. **ADR-0009 · Streaming 限额不可突破（maxStreamBytes）**
   - 为什么 hard limit 不是 soft warning
   - Why: memory safety、DoS 防御、成本控制

10. **ADR-0010 · Observe port vs. Langfuse/OTel 实现分离**
    - `@harness-one/core` 只定义 `MetricsPort`，实现包 `@harness-one/langfuse`、`@harness-one/opentelemetry` 独立
    - Why: 零依赖承诺 + 可替换性

**不要虚构决策**——每条 ADR 必须能在代码里找到证据（grep 到相应实现）。如果某条 ADR 找不到对应代码，说明这条不该写，跳过。

### File Ownership

- `docs/adr/**`（新建整个目录）

**不要碰**：源代码、测试、`docs/architecture/` 现有文件（可以在 ADR 里引用它们）、其他 Track 路径。

### DoD / 验收

- [ ] `docs/adr/README.md` 说明 ADR 流程
- [ ] `docs/adr/0000-adr-template.md` 作为模板
- [ ] 至少 5 条、最多 10 条 ADR，每条 ≤ 150 行
- [ ] 每条 ADR 的 "Decision" 都能在代码中 grep 到对应实现（在 ADR 文末附 "Evidence" 章节，列 3-5 个关键文件路径 + 函数名）
- [ ] `docs/adr/` 下 markdown `remark-lint` pass（若仓库有 lint），否则至少 `prettier --check docs/adr/` pass
- [ ] 不虚构、不浮夸，诚实写 negative consequences

### 纪律

1. 不改源代码
2. 不改测试
3. 不改 `docs/architecture/` 已有文件（可新链接引用）
4. ADR 写作风格：祈使句标题（"Use factory functions, not classes"）、中立语气、列 alternatives
5. 若 ADR 涉及未决策题，status 标 `Proposed` 而非 `Accepted`，在 PR 描述 flag 给 owner

## ---PROMPT END---
