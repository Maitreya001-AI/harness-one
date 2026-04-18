# Evolve Check

> 架构规则检查器。运行时可用的守卫——boot 时或 CI 中断言依赖图 /
> 层级边界等不变量，一旦违反即硬失败。

## 定位

大多数"演进"工作（组件注册、drift 检测、taste 编码）是**开发时**的
workflow，住在 `@harness-one/devkit`。但有一类检查属于**运行时安全保障**：
"我的 adapter 包不能反向依赖 core" "没有循环依赖" "L3 子系统之间互不
import"——这些如果真的在生产里出现，就是个应该立刻失败的事故。

`harness-one/evolve-check` 把这类**规则检查器**留在 core 包里，让 CI
和活动进程都能用同一套语义去验证。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/evolve-check/types.ts` | `ArchitectureRule`, `RuleContext`, `RuleResult` 接口 | ~34 |
| `src/evolve-check/architecture-checker.ts` | `createArchitectureChecker` + 两条内置规则 | ~230 |
| `src/evolve-check/index.ts` | 公共桶 | ~25 |
| `src/evolve-check/__tests__/*` | 测试 | - |

## 公共 API

### 类型

```ts
interface RuleContext {
  readonly imports: ReadonlyMap<string, readonly string[]>;  // file → imports
  readonly layers?: ReadonlyMap<string, string>;             // file → layer id
}

interface RuleResult {
  readonly rule: string;
  readonly passed: boolean;
  readonly violations: readonly { readonly file: string; readonly message: string }[];
}

type ArchitectureRule = (ctx: RuleContext) => RuleResult;
```

### 工厂函数 + 内置规则

**`createArchitectureChecker(rules: readonly ArchitectureRule[])`**
返回 `{ check(ctx): readonly RuleResult[] }`——对每条规则独立求值，
任一规则返回 `passed: false` 即整体失败。结果数组保持规则顺序，
`violations` 字段带 file / message 方便 CI 输出。

**`noCircularDepsRule`（内置）**
在 `ctx.imports` 上跑 Tarjan / DFS 环检测。每条环路返回一条 violation，
message 为 `file ← file ← ... ← file` 的链式说明。

**`layerDependencyRule`（内置）**
依赖 `ctx.layers` 声明每个 file 属于哪个 layer（例如 `'L1-infra'`、
`'L2-core'`、`'L3-<subsystem>'`）。规则：
- L1 不依赖任何人；
- L2 只依赖 L1；
- L3 只依赖 L2 + L1；
- L3 之间**绝不互相依赖**（type-only 也不行）。

违反时 violation 指向越界 import 的源文件与目标文件。

## 使用方式

### CI 模式

`@harness-one/devkit` 提供 `scanProject(rootDir)` 产生 `RuleContext`
（走 AST 扫描）。调用：

```ts
import { createArchitectureChecker, noCircularDepsRule, layerDependencyRule }
  from 'harness-one/evolve-check';
import { scanProject } from '@harness-one/devkit';

const ctx = await scanProject('./packages/core/src');
const checker = createArchitectureChecker([noCircularDepsRule, layerDependencyRule]);
const results = checker.check(ctx);
if (results.some(r => !r.passed)) process.exit(1);
```

### 运行时模式

生产代码里也可以跑——通常在 `bootstrap` / `createHarness` 里：

```ts
const checker = createArchitectureChecker([noCircularDepsRule]);
const results = checker.check(currentBundleGraph);
// 上报到 observability，或直接抛错终止启动
```

不过实际情况下 CI 拦截已足够——真正漏到运行时的依赖环是极少情况。
这个路径更多给自定义规则用：比如 "不允许任何文件 import 某个
deprecated module"。

## 规则扩展

自定义规则实现 `ArchitectureRule` 签名即可。推荐：

1. 规则名稳定——RuleResult.rule 字段用于 CI diff / trend。
2. 纯函数——无副作用，方便并行运行多条。
3. Violation 里带**可点击定位**的 file path，别只给 module 名。
4. 空 context 时返回 `passed: true`（没代码就没违规），不要抛错。

## 与 devkit 的分工

| 能力 | 位置 | 原因 |
|------|------|------|
| 规则检查器接口 + 内置规则 | `harness-one/evolve-check` | 运行时/CI 均需；类型稳定 |
| 组件 registry + drift 检测 | `@harness-one/devkit` | 开发时工具，有文件系统依赖 |
| Taste 编码（AST 指标、风格规约） | `@harness-one/devkit` | 开发时，大量依赖（AST parser） |
| `scanProject`（产生 RuleContext） | `@harness-one/devkit` | 走文件系统，不该进 core |

两边共享 RuleResult 类型；devkit 可以消费 evolve-check，反向不成立。

## 依赖关系

- **依赖**：无（纯数据结构 + 算法）。
- **被依赖**：`@harness-one/devkit` 和用户项目的 CI 脚本。

## 设计决策

1. **规则 = 纯函数**。无副作用，易测试，易并行。规则不应自己做 I/O——
   `RuleContext` 由调用方负责构造。
2. **内置只给最关键两条**——circular + layer。其余由用户按项目需求写
   自定义规则；core 不帮用户选择。
3. **运行时 + CI 共享同一套 API**——避免"CI 过了但生产逻辑不符"的漂移。
4. **独立于 devkit**——`evolve-check` 不拉 AST parser / 文件系统依赖，让
   core 包继续保持零运行时依赖。
