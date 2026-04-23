# CLI

> CLI 脚手架工具：`init` 交互式初始化 + `audit` 模块使用审计。
> 所在包：`@harness-one/cli`。

## 概述

cli 模块是 harness-one 的命令行工具，通过 `npx harness-one` 调用。
提供两个命令：

- **`init`** — 根据选择的模块在项目中生成 `harness/` 目录下的起步
  代码文件。
- **`audit`** — 扫描项目源码并输出客观的模块使用统计（每个模块的
  import 站点数、已用/未用模块数、总占比）。

仅使用 Node.js 内置模块，零外部运行时依赖。CLI 从
`harness-one/cli` 子路径抽离为独立包 `@harness-one/cli`，原先
820 行的单体文件拆成 `index.ts`（命令入口）/ `audit.ts`（扫描实现）/
`parser.ts`（参数解析）/ `ui.ts`（ANSI 颜色）/ `templates/*.ts`
（每个模块一个模板文件）四层。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `packages/cli/src/index.ts` | 命令入口：参数解析 → init / audit / help 分发 | 192 |
| `packages/cli/src/parser.ts` | `parseArgs(argv)` 手工解析 `process.argv.slice(2)` | 104 |
| `packages/cli/src/audit.ts` | `auditProject(cwd)`——递归扫描 + 模块 import 站点统计 | 92 |
| `packages/cli/src/ui.ts` | ANSI 颜色辅助（`NO_COLOR` / `FORCE_COLOR` / `isTTY` 协议） | 19 |
| `packages/cli/src/templates/index.ts` | 模板注册表：`TEMPLATES` / `FILE_NAMES` / `MODULE_DESCRIPTIONS` | 64 |
| `packages/cli/src/templates/subpath-map.ts` | 10 个模块名常量 + 类型 | 57 |
| `packages/cli/src/templates/core.ts` | `harness/agent.ts` 起步代码 | 49 |
| `packages/cli/src/templates/context.ts` | `harness/context.ts` 起步代码 | 52 |
| `packages/cli/src/templates/prompt.ts` | `harness/prompt.ts` 起步代码 | 55 |
| `packages/cli/src/templates/tools.ts` | `harness/tools.ts` 起步代码 | 52 |
| `packages/cli/src/templates/guardrails.ts` | `harness/guardrails.ts` 起步代码 | 56 |
| `packages/cli/src/templates/memory.ts` | `harness/memory.ts` 起步代码 | 60 |
| `packages/cli/src/templates/session.ts` | `harness/session.ts` 起步代码 | 48 |
| `packages/cli/src/templates/observe.ts` | `harness/observe.ts` 起步代码 | 58 |
| `packages/cli/src/templates/orchestration.ts` | `harness/orchestration.ts` 起步代码 | 82 |
| `packages/cli/src/templates/rag.ts` | `harness/rag.ts` 起步代码 | 73 |
| `packages/cli/src/templates/eval.ts` | `harness/eval.ts` 起步代码（走 `@harness-one/devkit`） | 68 |
| `packages/cli/src/templates/evolve.ts` | `harness/evolve.ts` 起步代码（走 `@harness-one/devkit`） | 79 |

## 公共 API

### 导出（供测试使用）

| 导出 | 位置 | 说明 |
|------|------|------|
| `ALL_MODULES` | `templates/subpath-map.ts` | 10 个模块名的常量数组 |
| `ModuleName` | `templates/subpath-map.ts` | 模块名类型 |
| `MODULE_DESCRIPTIONS` | `templates/index.ts` | 模块中文说明表 |
| `TEMPLATES` | `templates/index.ts` | 模块 → 模板字符串映射 |
| `FILE_NAMES` | `templates/index.ts` | 模块 → 文件名映射 |
| `ParsedArgs` | `parser.ts` | 解析后的命令行参数接口 |
| `parseArgs(argv)` | `parser.ts` | 参数解析函数 |
| `auditProject(cwd)` | `audit.ts` | 审计项目的模块使用情况 |

### 命令行用法

```
npx harness-one init                       # 交互式选择模块
npx harness-one init --all                 # 生成所有模块
npx harness-one init --modules core,tools  # 指定模块
npx harness-one audit                      # 审计模块使用
npx harness-one help                       # 显示帮助
```

## 内部实现

### 参数解析（`parser.ts`）

`parseArgs(argv)` 手工解析 `process.argv.slice(2)`，识别命令（init /
audit / help）、`--all` 标志、`--modules mod1,mod2` 参数。未知命令和
`--help` / `-h` 都映射到 help。

### init 流程（`index.ts`）

1. 如果未指定模块 → 交互式提示（`node:readline`）显示 10 个模块列表
2. 在 `cwd/harness/` 目录下创建对应文件（如 `agent.ts`、`tools.ts`）
3. 已存在的文件跳过（**不覆盖**）
4. 输出创建结果和下一步指引

### 模板内容（`templates/*.ts`）

每个模块一个 TS 文件，导出一个完整的字符串模板。模板内容包含：

- 正确的 `import` 语句（`harness-one/<module>` 子路径 / `@harness-one/*` 兄弟包）
- 带注释的使用示例
- 覆盖模块的核心 API

文件名映射：`core → agent.ts`，其余模块名与文件名一致（如 `tools → tools.ts`）。

### audit 流程（`audit.ts`）

1. 递归扫描 `cwd` 下的 `.ts/.tsx/.js/.jsx/.mjs` 文件（跳过 `node_modules`、`.git`、`dist`）
2. 正则匹配 `from 'harness-one/{module}'` 或 `from '@harness-one/{module}'` 导入语句
3. 统计每个模块的 import 站点数（同一模块多次导入会累计）
4. 输出完整模块列表：已使用模块显示 import 站点数，未使用模块显示 `not used`
5. 汇总 `Used: X / 12 modules` 和 `Import sites: Y`

示例输出：

```text
harness-one usage in /path/to/project:

  + core (12 import sites)
  + tools (8 import sites)
  + guardrails (3 import sites)
  - prompt (not used)
  - session (not used)
  ...

Used: 3 / 12 modules (25.0%)
Import sites: 23
```

### ANSI 颜色（`ui.ts`）

检测 `NO_COLOR`、`FORCE_COLOR`、`stdout.isTTY` 环境变量，支持 bold、green、red、yellow、cyan、dim 六种样式。

## 依赖关系

- **依赖**: 仅 Node.js 内置模块（`node:fs`、`node:path`、`node:readline`）
- **被依赖**: 无（入口程序；用户通过 `npx @harness-one/cli` 或全局安装后调用）

## 扩展点

- 新增模块时在 `templates/subpath-map.ts` 的 `ALL_MODULES` + `templates/index.ts` 的 `MODULE_DESCRIPTIONS` / `TEMPLATES` / `FILE_NAMES` 四处添加即可，再补一个 `templates/<module>.ts` 文件
- 模板代码是纯字符串，可独立修改
- audit 的模块识别规则是一个单独的正则——便于自定义扩展

## 设计决策

1. **零外部运行时依赖**——CLI 不引入 commander/yargs 等，手写参数解析保持轻量
2. **不覆盖已有文件**——`init` 跳过已存在的文件，安全幂等
3. **纯统计而非评判**——audit 只报告客观使用数据，不把“用了多少模块”偷换成“项目成熟度”
4. **模板即文档**——生成的代码本身就是该模块的使用示例
5. **单体拆分**——原 820 行的 `cli/index.ts` 按职责拆到 4 个专职文件 + 15 个模板文件，每个模板可单独维护，避免模板改动触发大文件 diff

## 已知限制

- 交互式提示仅支持数字选择，不支持模糊搜索
- audit 仅检测 `from 'harness-one/xxx'` / `from '@harness-one/xxx'` 格式的导入，不检测动态 import 或 require
- 模板代码是静态字符串，不根据项目配置（如 TypeScript 版本）适配
- 无 `update` 或 `remove` 命令
