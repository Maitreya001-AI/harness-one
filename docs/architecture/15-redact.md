# Redact

> 秘密脱敏原语。Logger、TraceManager、exporter 都经由此子路径，不是
> `observe` 的私有工具。

## 定位

redaction 是 core 级的横切关注点——一旦秘密（API key、token、password、
authorization 头等）进入 log 或 trace attribute，所有下游就都被污染。
`harness-one/redact` 把 redaction 提升为**独立一等子路径**，让 Logger /
TraceManager / 适配器 exporter 共享同一组契约与默认规则。

默认启用：`createLogger()` / `createTraceManager()` 无参构造即应用
`DEFAULT_SECRET_PATTERN`；关闭必须显式传 `redact: false`（Langfuse 更
严格——只接受替代函数，不接受 `false`）。

## 文件结构

实现全部落在 `infra/redact.ts`——`/redact` 子路径是**公共桶**，把
infra 模块里不对一般用户暴露的实现封成稳定 API。

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/infra/redact.ts` | 实现：pattern 编译、递归扫描、结构保留替换、引用 cycle 检测、DoS 保险 | 123 |
| `src/redact/index.ts` | 公共桶；不增加代码 | 18 |

## 公共 API

### 类型

| 类型 | 说明 |
|------|------|
| `RedactConfig` | `{ pattern?: RegExp; replacement?: string; useDefaultPattern?: boolean; keys?: readonly string[]; maxDepth?: number }` |
| `Redactor` | `(value: unknown) => unknown`——递归扫描并返回**拷贝**，不就地修改 |

### 常量

| 常量 | 说明 |
|------|------|
| `REDACTED_VALUE` | 默认替换字符串 `'[REDACTED]'`——跨 Logger / TraceManager / exporter 共用 |
| `DEFAULT_SECRET_PATTERN` | 默认正则，覆盖 `api[_-]?key`、`secret`、`password`、`token`、`authorization`、`bearer ...`、JWT 三段式等 |
| `POLLUTING_KEYS` | 原型污染黑名单：`__proto__`、`constructor`、`prototype`——即便 key 不命中 pattern 也会被剔除 |

### 工厂 + 辅助

**`createRedactor(config?): Redactor`**
编译配置为单个 redactor 闭包。`pattern` 与 `keys` 取并集；
`useDefaultPattern: true` 会把 `DEFAULT_SECRET_PATTERN` 合并进来。

**`redactValue(value, config?): unknown`**
一次性模式——不 cache config 编译。适合 ad-hoc 调用；高频路径请用
`createRedactor()` 换取复用。

**`sanitizeAttributes(attrs, redactor?): Record<string, unknown>`**
专为 span attributes 设计：顶层 key-value 结构的浅 sanitize + 值递归
redact。Langfuse / OpenTelemetry exporter 都跑这条路径。

## 实现要点

### 结构保留

输出 shape 与输入一致——object 仍是 object、array 仍是 array、
primitive 类型保持。命中的 string 值被替换为 `REDACTED_VALUE`；
非 primitive 命中 key 时整个值替换。这让下游 JSON.stringify、log
格式化、dashboard 显示都不需要做条件分支。

### 循环引用保险

内部 `WeakSet` 跟踪已访问的对象引用——相同的对象再次出现时原样返回
占位符 `'[Circular]'`，避免无限递归。测试覆盖了自引用 object、
交叉引用 graph、Array 内含自引用。

### DoS 保险

`maxDepth`（默认 32）限制递归深度；超过时子树被替换为 `'[TRUNCATED]'`
而不是抛错——redaction 永远不能因为输入结构异常而中断 log/trace。

### 原型污染剔除

`POLLUTING_KEYS` 中的键（`__proto__` / `constructor` / `prototype`）**无论
值是什么**都会在 redact 时被移除，防止恶意 span attribute 通过
`JSON.parse` → `Object.assign` 链污染原型。

### 性能

热路径全部走同一个 redactor 闭包——创建时一次性编译 pattern、
构建 keys Set。每次调用的成本是一次递归 + 正则测试，无字符串分配
除非命中。

## 依赖关系

- **依赖**：无。`infra/redact.ts` 是叶子模块。
- **被依赖**：
  - `infra/logger.ts` — Logger 默认构造时调用 `createRedactor()`
  - `observe/trace-manager.ts` — span attributes / metadata / events 都走
    `sanitizeAttributes`
  - `@harness-one/langfuse` — 导出默认 `sanitize` 闭包
  - `@harness-one/opentelemetry` — 同样走 `sanitizeAttributes`

## 设计决策

1. **redact 是 core-level，不是 observe 的私有工具**——Logger 也需要，
   不应依赖 observe 出现先后。
2. **默认 on，不是默认 off**——fail-closed。生产事故中"log 里含 API key"
   的代价远大于 "log 缺了某个诊断字段"。
3. **结构保留**——下游不改代码即可无缝启用。
4. **拷贝，不就地修改**——输入对象可能被业务代码复用；redact 修改会产生
   远程耦合 bug。
5. **cycle + depth + 原型污染三道 DoS 保险**——redact 永远不能 crash
   host 进程；测试覆盖所有三条路径。

## 扩展

- `createRedactor({ keys: [...] })` 补充自定义键黑名单；也可以传自己编译
  好的 `pattern`。
- `sanitizeAttributes(attrs, customRedactor)` 让 exporter 作者替换默认
  redactor，比如 PII 专用的 regex 组合。
