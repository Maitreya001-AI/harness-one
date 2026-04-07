// Install: npm install @pinecone-database/pinecone
//
// This example shows how to implement harness-one's MemoryStore interface
// with vector similarity search using Pinecone. Memory entries are stored
// with embeddings, enabling semantic search via searchByVector().

import { Pinecone } from '@pinecone-database/pinecone';
import type { MemoryStore } from 'harness-one/memory';
import type {
  MemoryEntry,
  MemoryFilter,
  CompactionPolicy,
  CompactionResult,
} from 'harness-one/memory';
import { createRelay } from 'harness-one/memory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function that generates embeddings for text. Bring your own embedder. */
type EmbedFn = (text: string) => Promise<number[]>;

// ---------------------------------------------------------------------------
// Vector MemoryStore implementation
// ---------------------------------------------------------------------------

/**
 * Create a MemoryStore backed by Pinecone for vector similarity search.
 *
 * This store satisfies the full MemoryStore interface AND implements the
 * optional searchByVector() method for embedding-based retrieval.
 *
 * Usage:
 *   const store = createVectorStore({
 *     apiKey: process.env.PINECONE_API_KEY!,
 *     indexName: 'agent-memory',
 *     embed: async (text) => openai.embeddings.create({ model: 'text-embedding-3-small', input: text }).then(r => r.data[0].embedding),
 *   });
 */
export function createVectorStore(config: {
  apiKey: string;
  indexName: string;
  namespace?: string;
  embed: EmbedFn;
}): MemoryStore {
  const pinecone = new Pinecone({ apiKey: config.apiKey });
  const index = pinecone.index(config.indexName);
  const ns = config.namespace ?? 'default';
  const embed = config.embed;

  // In-memory index for metadata filtering (Pinecone handles vector search,
  // but we keep a local map for the full MemoryEntry data since Pinecone
  // metadata has size limits).
  const localEntries = new Map<string, MemoryEntry>();
  let idCounter = 0;

  function generateId(): string {
    return `vmem_${Date.now()}_${++idCounter}`;
  }

  return {
    // -----------------------------------------------------------------------
    // write: embed content and upsert to Pinecone
    // -----------------------------------------------------------------------
    async write(input) {
      const now = Date.now();
      const entry: MemoryEntry = {
        id: generateId(),
        key: input.key,
        content: input.content,
        grade: input.grade,
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata,
        tags: input.tags,
      };

      // Generate embedding for the content
      const embedding = await embed(entry.content);

      // Upsert to Pinecone with metadata for filtering
      await index.namespace(ns).upsert([
        {
          id: entry.id,
          values: embedding,
          metadata: {
            key: entry.key,
            grade: entry.grade,
            tags: entry.tags?.join(',') ?? '',
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          },
        },
      ]);

      localEntries.set(entry.id, entry);
      return entry;
    },

    // -----------------------------------------------------------------------
    // read: fetch from local cache (or Pinecone metadata)
    // -----------------------------------------------------------------------
    async read(id) {
      return localEntries.get(id) ?? null;
    },

    // -----------------------------------------------------------------------
    // query: filter entries (uses local index for non-vector queries)
    // -----------------------------------------------------------------------
    async query(filter: MemoryFilter) {
      let results = Array.from(localEntries.values());

      if (filter.grade) {
        results = results.filter((e) => e.grade === filter.grade);
      }
      if (filter.tags && filter.tags.length > 0) {
        results = results.filter((e) =>
          filter.tags!.some((t) => e.tags?.includes(t)),
        );
      }
      if (filter.since !== undefined) {
        results = results.filter((e) => e.updatedAt >= filter.since!);
      }
      if (filter.search) {
        const term = filter.search.toLowerCase();
        results = results.filter((e) =>
          e.content.toLowerCase().includes(term),
        );
      }

      results.sort((a, b) => b.updatedAt - a.updatedAt);

      if (filter.limit !== undefined && filter.limit > 0) {
        return results.slice(0, filter.limit);
      }
      return results;
    },

    // -----------------------------------------------------------------------
    // update: re-embed and upsert
    // -----------------------------------------------------------------------
    async update(id, updates) {
      const existing = localEntries.get(id);
      if (!existing) {
        throw new Error(`Memory entry not found: ${id}`);
      }

      const updated: MemoryEntry = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };

      // Re-embed if content changed
      if (updates.content && updates.content !== existing.content) {
        const embedding = await embed(updated.content);
        await index.namespace(ns).upsert([
          {
            id: updated.id,
            values: embedding,
            metadata: {
              key: updated.key,
              grade: updated.grade,
              tags: updated.tags?.join(',') ?? '',
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
            },
          },
        ]);
      }

      localEntries.set(id, updated);
      return updated;
    },

    // -----------------------------------------------------------------------
    // delete: remove from Pinecone and local cache
    // -----------------------------------------------------------------------
    async delete(id) {
      const existed = localEntries.has(id);
      if (existed) {
        await index.namespace(ns).deleteOne(id);
        localEntries.delete(id);
      }
      return existed;
    },

    // -----------------------------------------------------------------------
    // compact: prune low-value entries
    // -----------------------------------------------------------------------
    async compact(policy: CompactionPolicy) {
      const now = Date.now();
      const weights = policy.gradeWeights ?? {
        critical: 1.0,
        useful: 0.5,
        ephemeral: 0.1,
      };
      const freed: string[] = [];

      // Remove entries exceeding maxAge
      if (policy.maxAge !== undefined) {
        for (const [id, entry] of localEntries) {
          if (now - entry.createdAt > policy.maxAge && weights[entry.grade] < 1.0) {
            await index.namespace(ns).deleteOne(id);
            localEntries.delete(id);
            freed.push(id);
          }
        }
      }

      // Trim to maxEntries
      if (policy.maxEntries !== undefined && localEntries.size > policy.maxEntries) {
        const sorted = Array.from(localEntries.values()).sort(
          (a, b) => weights[a.grade] - weights[b.grade] || a.updatedAt - b.updatedAt,
        );
        while (localEntries.size > policy.maxEntries && sorted.length > 0) {
          const victim = sorted.shift()!;
          if (weights[victim.grade] < 1.0) {
            await index.namespace(ns).deleteOne(victim.id);
            localEntries.delete(victim.id);
            freed.push(victim.id);
          } else {
            break;
          }
        }
      }

      return {
        removed: freed.length,
        remaining: localEntries.size,
        freedEntries: freed,
      };
    },

    // -----------------------------------------------------------------------
    // searchByVector: semantic similarity search via Pinecone
    // -----------------------------------------------------------------------
    async searchByVector(options) {
      const results = await index.namespace(ns).query({
        vector: [...options.embedding],
        topK: options.limit ?? 10,
        includeMetadata: true,
      });

      const entries: Array<MemoryEntry & { score: number }> = [];

      for (const match of results.matches ?? []) {
        const entry = localEntries.get(match.id);
        if (!entry) continue;

        const score = match.score ?? 0;
        if (options.minScore !== undefined && score < options.minScore) continue;

        entries.push({ ...entry, score });
      }

      return entries;
    },

    async count() {
      return localEntries.size;
    },

    async clear() {
      await index.namespace(ns).deleteAll();
      localEntries.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Example: use with createRelay for cross-context handoff
// ---------------------------------------------------------------------------

async function demo() {
  // Stub embedder for demonstration
  const embed: EmbedFn = async (_text) => new Array(1536).fill(0).map(() => Math.random());

  const store = createVectorStore({
    apiKey: process.env.PINECONE_API_KEY!,
    indexName: 'agent-memory',
    embed,
  });

  // Write some memories
  await store.write({ key: 'pref', content: 'User prefers dark mode', grade: 'useful', tags: ['prefs'] });
  await store.write({ key: 'fact', content: 'User lives in Tokyo', grade: 'critical', tags: ['profile'] });

  // Vector search: find memories similar to a query
  const queryEmbedding = await embed('What are the user preferences?');
  const similar = await store.searchByVector!({ embedding: queryEmbedding, limit: 5, minScore: 0.5 });
  console.log('Similar memories:', similar.map((e) => `${e.key}: ${e.content} (score: ${e.score.toFixed(3)})`));

  // Wire into a relay for cross-context handoff
  const relay = createRelay({ store });
  await relay.save({
    progress: { step: 'complete' },
    artifacts: ['report.pdf'],
    checkpoint: 'task-done',
    timestamp: Date.now(),
  });

  console.log('Relay state saved to vector-backed store');
}

demo().catch(console.error);
