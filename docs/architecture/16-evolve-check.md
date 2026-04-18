# Evolve Check

> 架构规则检查器。运行时可用的守卫——boot 时或 CI 中断言依赖图 /
> 层级边界等不变量，一旦违反即硬失败。

## 定位

大多数"演进"工作（组件注册、drift 检测、taste 编码）是**开发时**的
workflow，住在 `@harness-one/devkit`。但有一类检查属于**运行时安全保障**：
"我的 adapter 包不能反向依赖 core"、"没有循环依赖"、"L3 子系统之间互不
import"——这些如果真的在生产里出现，就是个应该立刻失败的事故。

`harness-one/evolve-check` 把这类**规则检查器**留在 core 包里，让 CI
和活动进程都能用同一套语义去验证。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/evolve-check/types.ts` | `ArchitectureRule`、`RuleContext`、`RuleResult` 接口 | 34 |
| `src/evolve-check/architecture-checker.ts` | `createArchitectureChecker` + 两条内置规则 + 结果缓存 | 230 |
| `src/evolve-check/index.ts` | 公共桶 | 25 |
| `src/evolve-check/__tests__/*` | 测试 | — |

## 公共 API

### 类型

```ts
/** A rule that checks architectural constraints. */
interface ArchitectureRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly check: (context: RuleContext) => RuleResult;
}

/** Context provided to architecture rule checks. */
interface RuleContext {
  readonly files: string[];
  readonly imports: Record<string, string[]>; // file path → list of imported paths
}

/** Result of an architecture rule check. */
interface RuleResult {
  readonly passed: boolean;
  readonly violations: Array<{
    file: string;
    message: string;
    suggestion: string;
  }>;
}
```

> 注意：`ArchitectureRule` 是带 `id`/`name`/`description`/`check` 字段的
> **对象**，不是 `(ctx) => RuleResult` 函数别名——稳定规则名用于 CI diff。

### 工厂函数 + 内置规则

**`createArchitectureChecker(): ArchitectureChecker`**

返回一个可变的 checker：

```ts
interface ArchitectureChecker {
  addRule(rule: ArchitectureRule): void;
  check(context: RuleContext): { passed: boolean; violations: RuleResult[] };
  listRules(): ArchitectureRule[];
}
```

`check()` 对每条规则独立求值，任一规则 `passed: false` 即整体失败，
同时把失败的 `RuleResult` 收集进 `violations` 数组。相同 context + 规则
集下的结果会被**缓存**（hash 比对），避免热点路径 DFS 重复计算。

**`noCircularDepsRule(allowedModules: string[]): ArchitectureRule`**

在 `ctx.imports` 上跑 DFS + 递归栈环检测。发现环时报出 `Circular
dependency detected: A -> B -> ... -> A` 的路径，并在 suggestion 字段
里给出"提取共享接口到独立模块"的修复建议。

**`layerDependencyRule(layers: Record<string, string[]>): ArchitectureRule`**

接收 `{ module: allowedDepsArray }` 映射；例如：

```ts
layerDependencyRule({
  core: [],                // L2 — 不依赖其他 L3 模块
  context: ['core'],       // L3 — 只能依赖 core / infra
  tools: ['core'],         // L3
});
```

模块识别使用**精确路径段匹配**：路径按 `/` 分割后检查某段是否与模块
名完全相等，而非子串包含。这避免了 `core` 误匹配 `core-utils` 或
`hardcore` 等同名前缀目录的问题。

违反时 violation 指向越界 import 的源文件，`message` 说明谁 import 了谁、
`suggestion` 列出允许依赖的模块清单。

## 使用方式

### CI 模式

`@harness-one/devkit` 提供 `scanProject(rootDir)` 产生 `RuleContext`（走
文件系统扫描 + 正则识别 import 语句）。调用：

```ts
import {
  createArchitectureChecker,
  noCircularDepsRule,
  layerDependencyRule,
} from 'harness-one/evolve-check';
import { scanProject } from '@harness-one/devkit';

const ctx = await scanProject('./packages/core/src');
const checker = createArchitectureChecker();
checker.addRule(noCircularDepsRule(['core', 'context', 'tools']));
checker.addRule(
  layerDependencyRule({
    core: [],
    context: ['core'],
    tools: ['core'],
  }),
);

const result = checker.check(ctx);
if (!result.passed) {
  for (const ruleResult of result.violations) {
    for (const v of ruleResult.violations) {
      console.error(`${v.file}: ${v.message}`);
      console.error(`  → ${v.suggestion}`);
    }
  }
  process.exit(1);
}
```

### 运行时模式

生产代码里也可以跑——通常在 `bootstrap` / `createHarness` 里：

```ts
const checker = createArchitectureChecker();
checker.addRule(noCircularDepsRule(['core', 'tools']));
const result = checker.check(currentBundleGraph);
if (!result.passed) throw new Error('architecture invariant violated');
```

不过实际情况下 CI 拦截已足够——真正漏到运行时的依赖环是极少情况。这个
路径更多给自定义规则用：比如"不允许任何文件 import 某个 deprecated
module"。

## 规则扩展

自定义规则实现 `ArchitectureRule` 接口即可。推荐：

1. 规则 `id` 稳定——用于 CI diff / trend。
2. `check` 是纯函数——无副作用，方便并行运行多条。
3. Violation 里带**可点击定位**的 `file` path，别只给 module 名；同时
   提供 `suggestion` 告诉读者怎么修。
4. 空 context 时返回 `passed: true`（没代码就没违规），不要抛错。

## 与 devkit 的分工

| 能力 | 位置 | 原因 |
|------|------|------|
| 规则检查器接口 + 内置规则 | `harness-one/evolve-check` | 运行时/CI 均需；类型稳定 |
| 组件 registry + drift 检测 | `@harness-one/devkit` | 开发时工具，有文件系统依赖 |
| Taste 编码（AST 指标、风格规约） | `@harness-one/devkit` | 开发时，大量依赖（AST parser） |
| `scanProject`（产生 RuleContext） | `@harness-one/devkit` | 走文件系统，不该进 core |

两边共享 `RuleResult` 类型；devkit 可以消费 evolve-check，反向不成立。

## 依赖关系

- **依赖**：无（纯数据结构 + 算法）。
- **被依赖**：`@harness-one/devkit` 和用户项目的 CI 脚本。

## 设计决策

1. **规则 = 纯函数 wrapper**。`ArchitectureRule.check` 无副作用、易测试、易
   并行；规则不应自己做 I/O——`RuleContext` 由调用方负责构造。
2. **内置只给最关键两条**——circular + layer。其余由用户按项目需求写自
   定义规则；core 不帮用户选择。
3. **运行时 + CI 共享同一套 API**——避免"CI 过了但生产逻辑不符"的漂移。
4. **独立于 devkit**——`evolve-check` 不拉 AST parser / 文件系统依赖，让
   core 包继续保持零运行时依赖。
5. **结果缓存**——相同 context + 规则集下重复调用复用上次结果，避免
   boot 路径上 DFS 重复计算。
