# Track O · Fuzz 测试 + STRIDE 威胁模型（P2）

**预估工时**：5 天  **依赖**：无

## Worktree setup

```bash
cd /Users/xrensiu/development/owner/harness-one
git worktree add ../harness-one-track-O -b testing/track-O-fuzz-threat main
cd ../harness-one-track-O
pnpm install --frozen-lockfile
claude
```

---

## ---PROMPT START---

你在 `harness-one` 仓库的一个独立 worktree 中工作（branch `testing/track-O-fuzz-threat`）。harness-one 暴露多个 parser/渲染器（tool args、guardrail input、SSE stream、prompt template），都是攻击面。

**任务**：对 4 个高风险 parser 做 fuzz + 为每个 L3 子系统写 STRIDE 威胁模型文档。

### 先读

```bash
grep -rn "JSON\.parse\|parseToolArguments" packages/core/src --include="*.ts" | head
grep -rn "SSE\|parseSSE\|stream" packages/core/src --include="*.ts" | head -20
grep -rn "template\|render" packages/core/src/prompt --include="*.ts" | head
grep -rn "GuardrailPipeline\|guardrail" packages/core/src/guardrails --include="*.ts" | head
ls packages/core/src/
cat docs/architecture/00-overview.md | head -60
```

### Part 1 · Fuzz 测试

用 `fast-check` 的 Arbitrary 做 fuzz（若 Track J 已加入 `fast-check` devDep，复用；否则本 track 加）。

放在 `packages/core/tests/fuzz/`：

```
tests/fuzz/
  tool-args-parser.fuzz.test.ts     # O1
  guardrail-input.fuzz.test.ts      # O2
  sse-stream-parser.fuzz.test.ts    # O3
  prompt-template.fuzz.test.ts      # O4
  corpus/                           # seed corpus（有意义的恶意样本）
```

#### O1 · Tool arguments parser
- 构造：深嵌套 JSON (`depth > 1000`)、`__proto__`/`constructor` 污染尝试、非法 utf8、BOM、超大字符串、数字边界（`Number.MAX_SAFE_INTEGER + 1`、`-0`、`NaN`、`Infinity`）
- 断言：parser 绝不抛 unhandled、要么返回 `ParseError` 要么返回合法结构；**永不**返回含 `__proto__` 污染的对象
- numRuns: 5000

#### O2 · Guardrail sensitivity 输入
- 构造：任意 unicode 字符串（含 zero-width、RTL、control）、超长（10MB）、空、全 null byte
- 断言：guardrail pipeline 不崩溃；超过限额的输入被正常拒绝（不是 panic）
- numRuns: 2000

#### O3 · SSE stream parser
- 构造：分片畸形（`event:` 无值、`data:` 多行、CR/LF 混用、BOM、`data:` 之间超大 gap、半行未闭合）
- 断言：parser 永不抛 uncaught；非法分片按契约 surface 为错误事件
- numRuns: 3000
- 包含 seed corpus（`corpus/sse/*.txt`）里 10-20 个已知畸形 sample

#### O4 · Prompt template 渲染
- 构造：占位符注入（`{{../../system}}`、`${process.env.XXX}`、模板字面量嵌套、循环引用）
- 断言：
  - 模板渲染绝不执行任意代码
  - 未定义变量按约定 surface（抛或保留原文，视实现）
  - 输出 **不包含** 未经 declared 的变量值（防止意外数据泄漏）
- numRuns: 2000

#### Fuzz 运行

- `pnpm fuzz` 本地全跑
- CI 不在每次 PR 跑（慢），`.github/workflows/fuzz.yml` 用 `schedule: cron '0 4 * * *'` + `workflow_dispatch`
- 失败时 seed 打印出来方便复现

### Part 2 · STRIDE 威胁模型

为每个 L3 子系统写一份 `docs/security/<subsystem>.md`，基于架构文档 `docs/architecture/0X-*.md` 对应：

子系统清单（以现有 `docs/architecture/` 编号为准）：
- `01-core.md` → `docs/security/core.md`
- `02-prompt.md` → `docs/security/prompt.md`
- `03-context.md` → `docs/security/context.md`
- `04-tools.md` → `docs/security/tools.md`
- `05-guardrails.md` → `docs/security/guardrails.md`
- `06-observe.md` → `docs/security/observe.md`
- `07-session.md` → `docs/security/session.md`
- `08-memory.md` → `docs/security/memory.md`
- `13-rag.md` → `docs/security/rag.md`
- `15-redact.md` → `docs/security/redact.md`

每份文档结构（≤ 150 行）：

```markdown
# <Subsystem> · Threat Model

## Trust boundaries
- <列出进出该子系统的边界：用户输入、LLM 输出、FS、网络>

## STRIDE
### Spoofing
- Threat: ...
- Mitigation: ...
- Evidence: <链到代码 file:line>

### Tampering
...
### Repudiation
...
### Information Disclosure
...
### Denial of Service
...
### Elevation of Privilege
...

## Residual risks
- <坦诚列出未缓解的风险，交给 guardrail / 上层处理>

## References
- docs/architecture/0X-*.md
- docs/adr/XXXX-*.md（如 Track F 已合并）
```

**纪律**：不要虚构威胁，每条 Mitigation 都必须在代码里能 grep 到对应实现。查无实证的威胁标 "Unmitigated — tracked in issue #TBD" 而不是编造缓解措施。

### File Ownership

- `packages/core/tests/fuzz/**`（新建）
- `.github/workflows/fuzz.yml`（新建）
- `packages/core/package.json`（若 Track J 未加 `fast-check` 则本 track 加；加 `fuzz` script）
- `docs/security/*.md`（新建多份）
- `docs/architecture/17-testing.md`（**必须更新**，fuzz 章节）

**不要碰**：源码（fuzz 发现的真漏洞开 issue，不改）、其他 Track 路径。

### DoD / 验收

- [ ] 4 个 fuzz 套件全绿（numRuns 达标）
- [ ] seed corpus 至少每个 fuzz target 10 个样本
- [ ] Fuzz workflow yml 通过 `actionlint`
- [ ] STRIDE 文档覆盖至少 8 个子系统（10 个理想）
- [ ] 每个 STRIDE Mitigation 有 file:line 证据
- [ ] `docs/architecture/17-testing.md` 更新

### 纪律

1. 发现真漏洞→**只开 issue**，不在本 PR 修（单独 coordinated disclosure 流程走 `SECURITY.md`）
2. STRIDE 拒绝虚构——宁可写 "Unmitigated" 也不编造 mitigation
3. 改测试层架构，更新 `docs/architecture/`
4. Commit 粒度：每个 fuzz target 一个、每份 STRIDE 一个

## ---PROMPT END---
