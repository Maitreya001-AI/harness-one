# RAG — Retrieval-Augmented Generation

> Document loading, chunking, embedding, and retrieval pipeline. Zero external dependencies.

## 概述

rag 模块提供将文档转化为可检索上下文的完整流水线：加载 → 分块 → 嵌入 → 索引 → 查询。每个阶段都定义了接口（`DocumentLoader`、`ChunkingStrategy`、`EmbeddingModel`、`Retriever`），内置实现开箱即用，用户可在任意阶段注入自定义实现。

`RetrievalResult` 包含 `tokens` 字段（`content.length / 4` 启发式估算），帮助调用方在 token 预算内精确控制注入到上下文的检索结果数量。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/rag/types.ts` | 核心类型：`Document`、`DocumentChunk`、`EmbeddingModel`、`Retriever`、`RetrievalResult`、`IngestMetrics` 等 | 124 |
| `src/rag/loaders.ts` | 内置加载器：`createTextLoader`、`createDocumentArrayLoader` | 63 |
| `src/rag/chunking.ts` | 内置分块策略：`FixedSize`、`Paragraph`、`SlidingWindow`；CJK 字符边界 + emoji surrogate-pair 识别 | 279 |
| `src/rag/retriever.ts` | 内置检索器：`createInMemoryRetriever`（余弦相似度 + LRU 查询缓存 + 多租户隔离 SEC-010 + `clear()`） | 314 |
| `src/rag/pipeline.ts` | 流水线编排：`createRAGPipeline`；去重 + 容量上限 + AbortSignal | 380 |
| `src/rag/index.ts` | 公共导出桶文件 | 36 |

## 公共 API

### 核心类型

| 类型 | 说明 |
|------|------|
| `Document` | 待处理的原始文档（id、content、metadata?、source?） |
| `DocumentChunk` | 分块后的片段（id、documentId、content、index、embedding?） |
| `RetrievalResult` | 检索结果（chunk、score、tokens?） |
| `DocumentLoader` | 文档加载接口：`load(): Promise<Document[]>` |
| `ChunkingStrategy` | 分块策略接口：`name` + `chunk(doc): DocumentChunk[]` |
| `EmbeddingModel` | 嵌入模型接口：`embed(texts): Promise<readonly number[][]>` + `dimensions` |
| `Retriever` | 检索器接口：`index(chunks)` + `retrieve(query, options?)` |
| `RAGPipelineConfig` | 流水线配置：loader?、chunking?、embedding、retriever、maxChunks?、onWarning? |
| `RAGPipeline` | 完整流水线：ingest()、ingestDocuments()、query()、getChunks()、clear() |

### 文档加载器

```ts
// 从字符串数组创建文档
const loader = createTextLoader(
  ['TypeScript is a typed superset.', 'Harness engineering is the hard 30%.'],
  { source: 'docs' },
);
const docs = await loader.load();
// docs[0] = { id: 'doc_0', content: '...', source: 'docs', metadata: {} }

// 从预构建 Document 数组直通
const loader2 = createDocumentArrayLoader([
  { id: 'custom-1', content: 'Pre-built doc', metadata: { version: 2 } },
]);
```

### 分块策略

**FixedSize** — 按字符数切分，支持重叠：

```ts
const chunking = createFixedSizeChunking({ chunkSize: 512, overlap: 64 });
// overlap < chunkSize，否则抛出 RAG_INVALID_CONFIG
```

**Paragraph** — 按双换行切分，超长段落自动子切分：

```ts
const chunking = createParagraphChunking({ maxChunkSize: 500 });
// 无 maxChunkSize 时保留原始段落长度
```

**SlidingWindow** — 固定窗口大小 + 固定步长：

```ts
const chunking = createSlidingWindowChunking({ windowSize: 300, stepSize: 150 });
// 步长 150 → 相邻窗口重叠 150 字符
```

### 检索器

`createInMemoryRetriever` 使用余弦相似度对嵌入向量排序，内置 LRU 查询缓存（默认 64 条）：

```ts
const retriever = createInMemoryRetriever({
  embedding: myEmbeddingModel,
  queryCacheSize: 128, // 可选，默认 64
});

await retriever.index(embeddedChunks);
const results = await retriever.retrieve('query text', { limit: 5, minScore: 0.5 });
```

未附加嵌入向量的 chunk 会被跳过。检索结果按 score 降序排列。

### 流水线编排

```ts
import {
  createTextLoader,
  createParagraphChunking,
  createInMemoryRetriever,
  createRAGPipeline,
} from 'harness-one/rag';

const pipeline = createRAGPipeline({
  loader: createTextLoader(['Doc A content', 'Doc B content']),
  chunking: createParagraphChunking({ maxChunkSize: 500 }),
  embedding: myEmbeddingModel,           // 实现 EmbeddingModel 接口
  retriever: createInMemoryRetriever({ embedding: myEmbeddingModel }),
  maxChunks: 10_000,                     // 可选容量上限
  onWarning: ({ message, type }) => console.warn(type, message),
});

// 完整摄入：loader → chunking → embedding → index
const { documents, chunks } = await pipeline.ingest();

// 直接摄入预加载文档（跳过 loader）
const added = await pipeline.ingestDocuments([{ id: 'd1', content: '...' }]);

// 查询：embed query → cosine similarity → top-k
const results = await pipeline.query('What is harness engineering?', { limit: 3 });
for (const { chunk, score, tokens } of results) {
  console.log(`[${score.toFixed(3)}] ~${tokens} tokens: ${chunk.content.slice(0, 80)}`);
}
```

## Token 计数集成

`RetrievalResult.tokens` 由 `pipeline.query()` 自动填充，计算方式为 `Math.ceil(content.length / 4)`（与 `infra/token-estimator` 同一启发式）。调用方可据此在向 LLM 注入检索结果前剔除超出 token 预算的条目：

```ts
let budget = 2000; // 可用 token 数
const injected = results.filter((r) => {
  if ((r.tokens ?? 0) > budget) return false;
  budget -= r.tokens ?? 0;
  return true;
});
```

## 去重与容量管理

- **去重**：`createRAGPipeline` 在内部维护已索引内容的哈希集合。同批次内和跨批次的重复 chunk 均会跳过，并触发 `onWarning({ type: 'duplicate' })`。
- **容量上限**：`maxChunks` 限制流水线的总 chunk 数。达到上限后新 chunk 不被添加，触发 `onWarning({ type: 'capacity' })`。未设置 `maxChunks` 时，默认上限为 100,000 chunks 以防止无限内存增长（Wave-7）。
- **清空**：`pipeline.clear()` 清除所有已索引 chunk 和内容哈希，但不重置检索器的内部状态（需重新创建流水线以彻底重置）。

## 依赖关系

- **依赖**: `core/errors.ts`（HarnessError，用于配置校验和嵌入维度不匹配）
- **被依赖**: 无模块依赖此模块（独立可用）

## 扩展点

| 接口 | 注入方式 | 用途 |
|------|---------|------|
| `EmbeddingModel` | `createRAGPipeline({ embedding })` 和 `createInMemoryRetriever({ embedding })` | 接入 OpenAI Embeddings、Cohere、本地模型等 |
| `DocumentLoader` | `createRAGPipeline({ loader })` | 从数据库、S3、API 等加载文档 |
| `ChunkingStrategy` | `createRAGPipeline({ chunking })` | 自定义语义分块（如按句子、按代码块） |
| `Retriever` | `createRAGPipeline({ retriever })` | 接入 Pinecone、Weaviate、pgvector 等向量数据库 |

## 设计决策

1. **无外部依赖** —— 余弦相似度和 LRU 缓存均为内部实现，不引入向量数据库 SDK
2. **嵌入与索引分离** —— `EmbeddingModel` 和 `Retriever` 是独立接口，可分别替换（例如：使用 OpenAI Embeddings + 本地内存检索，或自定义嵌入 + Pinecone）
3. **tokens 字段可选** —— `RetrievalResult.tokens` 标记为 `number | undefined`，不强制依赖 token 估算；调用方按需使用
4. **去重在嵌入之前** —— 重复 chunk 在 embedding API 调用之前过滤，避免浪费嵌入配额
5. **查询缓存** —— 对相同查询文本复用嵌入向量，减少重复的嵌入 API 调用

## Wave-8 Production Hardening

1. **AbortSignal 支持**：`RAGPipelineConfig.signal` 新增可选的 `AbortSignal` 字段，允许调用方取消进行中的 ingest 操作。
2. **CJK 词边界检测**：分块策略现在识别 CJK（中日韩）字符边界，并正确保留 surrogate pair（emoji），避免在 CJK 文本或 emoji 中间截断。
3. **Retriever clear()**：内存检索器 `createInMemoryRetriever` 新增 `clear()` 方法，可重置所有已索引的 chunk 和缓存。

## 已知限制

- `createInMemoryRetriever` 不支持持久化——进程重启后需重新索引
- 余弦相似度为精确搜索，数据量大时性能随 chunk 数线性下降（无近似向量搜索）
- `clear()` 仅清除流水线状态；内存检索器可通过 `retriever.clear()` 单独重置索引和缓存（Wave-8 新增）
