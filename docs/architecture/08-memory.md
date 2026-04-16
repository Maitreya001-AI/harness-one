# Memory

> 记忆与持久化：MemoryStore 接口、内存/文件系统实现、分级压缩、跨上下文接力。

## 概述

memory 模块提供 Agent 长期记忆能力：MemoryStore 接口定义 CRUD + 查询 + 压缩操作；两个实现——InMemoryStore（测试/简单场景）和 FileSystemStore（文件持久化）；CompactionPolicy 按 grade 权重自动清理；ContextRelay 支持跨 agent 上下文的状态接力。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/memory/types.ts` | 类型定义：MemoryEntry、MemoryFilter、CompactionPolicy、RelayState | ~85 |
| `src/memory/store.ts` | MemoryStore 接口 + MemoryStoreCapabilities + createInMemoryStore | ~240 |
| `src/memory/fs-io.ts` | 文件 I/O 原语（读/写/批量/索引），含 schema 校验 | ~200 |
| `src/memory/fs-store.ts` | createFileSystemStore——文件系统后端 | ~251 |
| `src/memory/relay.ts` | createRelay——跨上下文接力 | ~240 |
| `src/memory/_schemas.ts` | JSON 反序列化边界的 schema 校验（0.2.0 新增） | ~110 |
| `src/memory/testkit.ts` | runMemoryStoreConformance — 可在任意测试框架下运行的合规套件（0.2.0 新增） | ~120 |
| `src/memory/index.ts` | 公共导出桶文件 | ~45 |

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
| `capabilities?` | 0.2.0 — 声明后端支持的能力（见下表） |
| `write(entry)` | 写入条目（自动生成 id 和时间戳） |
| `read(id)` | 按 ID 读取 |
| `query(filter)` | 条件查询，按 updatedAt 降序排列 |
| `update(id, updates)` | 更新条目的 content/grade/metadata/tags |
| `delete(id)` | 删除条目 |
| `compact(policy)` | 按策略压缩 |
| `count()` | 返回条目总数 |
| `clear()` | 清空所有条目 |
| `writeBatch?(entries)` | 0.2.0 — 批量写入，当 `capabilities.atomicBatch` 为 true 时原子 |
| `searchByVector?(options)` | 可选：向量相似度搜索，返回 `Array<MemoryEntry & { score }>` |

**MemoryStoreCapabilities（0.2.0）**

后端通过 `capabilities` 字段如实声明它支持的契约级别。字段都是可选布尔——缺省视为 `false`。

| 字段 | 含义 |
|------|------|
| `atomicWrite` | `write()` 在单进程并发下原子 |
| `atomicBatch` | `writeBatch()` 全成功或全失败 |
| `atomicUpdate` | `update()` 采用 CAS 语义 |
| `ttl` | 通过 `metadata.ttlMs` 支持自动过期 |
| `vectorSearch` | 实现 `searchByVector()` |
| `batchWrites` | 实现 `writeBatch()` |

调用方据此决定是否使用批量接口、是否假设原子性。

**ContextRelay**

| 方法 | 说明 |
|------|------|
| `save(state)` | 保存接力状态 |
| `load()` | 加载接力状态 |
| `checkpoint(progress)` | 更新进度并生成检查点 |
| `addArtifact(path)` | 追加产物路径 |
| `dispose()` | Wave-8: 释放内部缓存和引用，防止长运行服务内存泄漏 |

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

ContextRelay 将 RelayState 序列化为 JSON 存入 MemoryStore（key 为 `__relay__`，grade 为 `critical`）。通过 `findRelay()` 内部方法查找，优先使用缓存的 currentId，否则通过 query 搜索。

从 0.2.0 起，JSON.parse 后的内容会经 `validateRelayState()` 做 shape 校验；shape 不匹配与 JSON 解析失败都会通过 `onCorruption` 回调上报并跳过，不再静默当作空 relay 处理。

### 持久化边界 schema 校验（0.2.0）

磁盘/网络上的每一字节都是不可信的——手动编辑、半写入、版本迁移、字节翻转都可能让 `JSON.parse(...) as T` 悄悄把坏数据解成"看起来合法的类型"。`src/memory/_schemas.ts` 提供一组轻量校验器在每个反序列化点做 shape 检查：

| 校验器 | 用途 |
|---|---|
| `validateMemoryEntry(v)` | 校验 id / key / content / grade / createdAt / updatedAt / metadata / tags |
| `validateIndex(v)` | 校验 fs-store 的 `_index.json`：`keys` 必须是 `string → 非空 string` |
| `validateRelayState(v)` | 校验 progress / artifacts / checkpoint / timestamp / _version |
| `parseJsonSafe(raw)` | 不抛错的 `JSON.parse` 包装，返回 `{ ok: true, value }` 或 `{ ok: false, error }` |

校验失败会抛 `HarnessError('STORE_CORRUPTION')`，带上错误路径（如 `$.grade`）和修复建议。`fs-io.ts` 的 `readIndex` / `readEntry`、`relay.ts` 的两处 load、`@harness-one/redis` 的 4 处 JSON.parse 都用这些校验器替换了原先的 `as T` 强转。

校验器**从 `harness-one/memory` 公开导出**，第三方 MemoryStore 后端实现时应在自己的反序列化路径上调用相同的校验器，以免契约规避。

### 查询能力

query 支持多条件组合过滤：按 grade、tags（OR 匹配）、since（时间范围）、search（内容子串搜索），结果按 updatedAt 降序。

## 依赖关系

- **依赖**: `core/errors.ts`（HarnessError）、`node:fs/promises`（仅 fs-store）、`node:path`（仅 fs-store）
- **被依赖**: 无直接模块依赖

## 扩展点

- 实现 `MemoryStore` 接口对接任意存储后端（Redis、SQLite、向量数据库等）
- 实现可选的 `searchByVector()` 方法，为 embedding-backed store 提供向量相似度搜索能力。`VectorSearchOptions` 接受查询向量、结果数量上限和最低分数阈值（见 `examples/memory/vector-store.ts`）
- 实现可选的 `writeBatch()` 并在 `capabilities` 中声明 `atomicBatch: true`，调用方即可放心批量写入
- 在反序列化路径上调用公开的 `validateMemoryEntry` / `validateIndex`，避免与核心契约偏离
- CompactionPolicy.gradeWeights 自定义各级别的保留权重
- ContextRelay 通过 relayKey 隔离不同接力上下文

## 合规测试套件（0.2.0）

任何新的 MemoryStore 实现应通过 `runMemoryStoreConformance(runner, factory)`——一份框架无关的合规套件，验证是否履行 write/read/query/update/delete/count/clear 及 capabilities 声明的契约。内存实现自己也跑这套测试 dogfooding：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryStore, runMemoryStoreConformance } from 'harness-one/memory';

runMemoryStoreConformance(
  { describe, it, expect, beforeEach },
  () => createInMemoryStore(),
);
```

新后端（Postgres / DynamoDB / Vespa）按此模式接入即可。

## 设计决策

1. **三级 grade 而非数字分数**——语义明确，critical 永不自动清理
2. **MemoryStore 全异步接口**——兼容文件系统和网络存储后端
3. **Relay 复用 MemoryStore**——不引入新的存储层，接力状态和普通记忆使用相同后端
4. **文件系统一条目一文件**——简单直观，不需要额外数据库依赖

## Wave-8 Production Hardening

1. **ContextRelay 资源释放**：`ContextRelay` 新增 `dispose()` 方法，用于清理内部缓存和引用，防止长运行服务中的内存泄漏。
2. **向量搜索 top-K 优化**：`searchByVector()` 使用有界 top-K 选择算法（O(N·K) 复杂度），替代此前的全排序（O(N log N)），在 K 远小于 N 的典型检索场景下显著降低计算开销。
3. **writeBatch 原子性保证**：`writeBatch()` 在部分索引写入失败时回滚所有已写入条目，确保真正的全成功或全失败（all-or-nothing）语义。

## 已知限制

- InMemoryStore 无持久化，进程重启数据丢失
- FileSystemStore 具有单进程并发安全（异步互斥锁），但不支持多进程并发
- query 的 search 是内存全扫描子串匹配，不支持全文索引
- ContextRelay 的 findRelay 依赖 query 的 search 参数匹配 key，需要 store 实现的 search 支持 key 内容搜索
