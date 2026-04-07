# CLI

> CLI 脚手架工具：`init` 交互式初始化 + `audit` 模块使用审计。

## 概述

cli 模块是 harness-one 的命令行工具，通过 `npx harness-one` 调用。提供两个命令：`init` 根据选择的模块在项目中生成 `harness/` 目录下的起步代码文件；`audit` 扫描项目源码检测 harness-one 模块的使用情况并评估成熟度等级。仅使用 Node.js 内置模块，零外部依赖。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/cli/index.ts` | 完整 CLI 实现：参数解析、模板生成、init、audit、help | ~816 |

## 公共 API

### 导出（供测试使用）

| 导出 | 说明 |
|------|------|
| `ALL_MODULES` | 10 个模块名的常量数组 |
| `ModuleName` | 模块名类型 |
| `ParsedArgs` | 解析后的命令行参数接口 |
| `parseArgs(argv)` | 参数解析函数 |
| `getTemplate(mod)` | 获取指定模块的模板代码 |
| `auditProject(cwd)` | 审计项目的模块使用情况 |

### 命令行用法

```
npx harness-one init                       # 交互式选择模块
npx harness-one init --all                 # 生成所有模块
npx harness-one init --modules core,tools  # 指定模块
npx harness-one audit                      # 审计模块使用
npx harness-one help                       # 显示帮助
```

## 内部实现

### 参数解析

`parseArgs(argv)` 手工解析 `process.argv.slice(2)`，识别命令（init/audit/help）、`--all` 标志、`--modules mod1,mod2` 参数。未知命令和 `--help` / `-h` 都映射到 help。

### init 流程

1. 如果未指定模块 → 交互式提示（readline）显示 10 个模块列表
2. 在 `cwd/harness/` 目录下创建对应文件（如 `agent.ts`、`tools.ts`）
3. 已存在的文件跳过（不覆盖）
4. 输出创建结果和下一步指引

### 模板内容

每个模块有一个完整的 TypeScript 模板，包含：
- 正确的 import 语句
- 带注释的使用示例
- 覆盖模块的核心 API

文件名映射：core → `agent.ts`，其余模块名与文件名一致（如 tools → `tools.ts`）。

### audit 流程

1. 递归扫描 cwd 下的 `.ts/.tsx/.js/.jsx/.mjs` 文件（跳过 node_modules、.git、dist）
2. 正则匹配 `from 'harness-one/{module}'` 导入语句
3. 统计已使用和未使用的模块
4. 计算成熟度等级：None (0) → Starter (1-2) → Basic (3-4) → Intermediate (5-6) → Advanced (7-8) → Comprehensive (9-10)

### ANSI 颜色

检测 `NO_COLOR`、`FORCE_COLOR`、`stdout.isTTY` 环境变量，支持 bold、green、red、yellow、cyan、dim 六种样式。

## 依赖关系

- **依赖**: 仅 Node.js 内置模块（`node:fs`、`node:path`、`node:readline`）
- **被依赖**: 无（入口程序）

## 扩展点

- 新增模块时在 `ALL_MODULES`、`MODULE_DESCRIPTIONS`、`TEMPLATES`、`FILE_NAMES` 四处添加即可
- 模板代码是纯字符串，可独立修改

## 设计决策

1. **零外部依赖**——CLI 不引入 commander/yargs 等，手写参数解析保持轻量
2. **不覆盖已有文件**——init 跳过已存在的文件，安全幂等
3. **成熟度等级**——audit 提供可量化的采用度指标，激励渐进式采用
4. **模板即文档**——生成的代码本身就是该模块的使用示例

## 已知限制

- 交互式提示仅支持数字选择，不支持模糊搜索
- audit 仅检测 `from 'harness-one/xxx'` 格式的导入，不检测动态 import 或 require
- 模板代码是静态字符串，不根据项目配置（如 TypeScript 版本）适配
- 无 `update` 或 `remove` 命令
