# Memory

> 记忆与持久化：MemoryStore 接口、内存/文件系统实现、分级压缩、跨上下文接力。

## 概述

memory 模块提供 Agent 长期记忆能力：MemoryStore 接口定义 CRUD + 查询 + 压缩操作；两个实现——InMemoryStore（测试/简单场景）和 FileSystemStore（文件持久化）；CompactionPolicy 按 grade 权重自动清理；ContextRelay 支持跨 agent 上下文的状态接力。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/memory/types.ts` | 类型定义：MemoryEntry、MemoryFilter、CompactionPolicy、RelayState | ~70 |
| `src/memory/store.ts` | MemoryStore 接口 + createInMemoryStore | ~168 |
| `src/memory/fs-store.ts` | createFileSystemStore——文件系统后端 | ~251 |
| `src/memory/relay.ts` | createRelay——跨上下文接力 | ~126 |
| `src/memory/index.ts` | 公共导出桶文件 | ~27 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `MemoryGrade` | `'critical' \| 'useful' \| 'ephemeral'` |
| `MemoryEntry` | 记忆条目：id、key、content、grade、tags、metadata、时间戳 |
| `MemoryFilter` | 查询条件：grade、tags、since、limit、offset、search |
| `VectorSearchOptions` | 向量搜索选项：embedding (number[])、limit?、minScore? (0-1) |
| `CompactionPolicy` | 压缩策略：maxEntries、maxAge、gradeWeights |
| `CompactionResult` | 压缩结果：removed、remaining、freedEntries |
| `RelayState` | 接力状态：progress、artifacts、checkpoint、timestamp |

### 接口

**MemoryStore**

| 方法 | 说明 |
|------|------|
| `write(entry)` | 写入条目（自动生成 id 和时间戳） |
| `read(id)` | 按 ID 读取 |
| `query(filter)` | 条件查询，按 updatedAt 降序排列 |
| `update(id, updates)` | 更新条目的 content/grade/metadata/tags |
| `delete(id)` | 删除条目 |
| `compact(policy)` | 按策略压缩 |
| `count()` | 返回条目总数 |
| `clear()` | 清空所有条目 |
| `searchByVector?(options)` | 可选：向量相似度搜索，返回 `Array<MemoryEntry & { score }>` |

**ContextRelay**

| 方法 | 说明 |
|------|------|
| `save(state)` | 保存接力状态 |
| `load()` | 加载接力状态 |
| `checkpoint(progress)` | 更新进度并生成检查点 |
| `addArtifact(path)` | 追加产物路径 |

### 工厂函数

```ts
function createInMemoryStore(): MemoryStore
function createFileSystemStore(config: { directory: string; indexFile?: string }): MemoryStore
function createRelay(config: { store: MemoryStore; relayKey?: string }): ContextRelay
```

## 内部实现

### 分级压缩

CompactionPolicy 通过 gradeWeights 控制清理优先级（默认 critical: 1.0, useful: 0.5, ephemeral: 0.1）。`weight < 1.0` 的条目才会被清理。流程：
1. 按 maxAge 删除过期条目（critical 豁免）
2. 按 maxEntries 裁剪——按 weight 升序 + updatedAt 升序排列，从最低权重最旧的开始删除

### 文件系统存储

每个条目存为 `{directory}/{id}.json`，另有 `_index.json` 维护 key-to-id 映射。所有操作前调用 `ensureDir()` 确保目录存在。compact 后重建 index。

所有索引操作（write/delete/compact/clear）通过异步互斥锁（`withIndexLock`）串行化，防止并发 read-modify-write 导致索引损坏。互斥锁为进程内实现，不适用于多进程场景。

`update(id, updates)` 在互斥锁内完成读取-修改-写回三步操作。锁保证整个 update 过程的原子性，并发 update 调用不会出现写覆盖（last-write-wins 导致更新丢失）问题。

compact() 使用批量删除（Promise.all，每批 50 个文件）并行执行文件删除，代替逐个串行删除。

### 向量维度校验

`searchByVector()` 在执行相似度计算前，校验查询向量与存储条目向量的维度是否一致。维度不匹配时抛出 `HarnessError`，而非返回无意义的相似度分数或静默错误。

### 接力机制

ContextRelay 将 RelayState 序列化为 JSON 存入 MemoryStore（key 为 `__relay__`，grade 为 `critical`）。通过 `findRelay()` 内部方法查找，优先使用缓存的 currentId，否则通过 query 搜索。JSON.parse 调用包裹在 try-catch 中——损坏的 relay 数据返回 null 而非抛出未处理的 SyntaxError。

### 查询能力

query 支持多条件组合过滤：按 grade、tags（OR 匹配）、since（时间范围）、search（内容子串搜索），结果按 updatedAt 降序。

## 依赖关系

- **依赖**: `core/errors.ts`（HarnessError）、`node:fs/promises`（仅 fs-store）、`node:path`（仅 fs-store）
- **被依赖**: 无直接模块依赖

## 扩展点

- 实现 `MemoryStore` 接口对接任意存储后端（Redis、SQLite、向量数据库等）
- 实现可选的 `searchByVector()` 方法，为 embedding-backed store 提供向量相似度搜索能力。`VectorSearchOptions` 接受查询向量、结果数量上限和最低分数阈值（见 `examples/memory/vector-store.ts`）
- CompactionPolicy.gradeWeights 自定义各级别的保留权重
- ContextRelay 通过 relayKey 隔离不同接力上下文

## 设计决策

1. **三级 grade 而非数字分数**——语义明确，critical 永不自动清理
2. **MemoryStore 全异步接口**——兼容文件系统和网络存储后端
3. **Relay 复用 MemoryStore**——不引入新的存储层，接力状态和普通记忆使用相同后端
4. **文件系统一条目一文件**——简单直观，不需要额外数据库依赖

## 已知限制

- InMemoryStore 无持久化，进程重启数据丢失
- FileSystemStore 具有单进程并发安全（异步互斥锁），但不支持多进程并发
- query 的 search 是内存全扫描子串匹配，不支持全文索引
- ContextRelay 的 findRelay 依赖 query 的 search 参数匹配 key，需要 store 实现的 search 支持 key 内容搜索
