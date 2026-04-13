# @harness-one/redis

Redis-backed `MemoryStore` implementation for `harness-one/memory`. Persistent, filterable memory with configurable TTL and operator-facing `repair()`.

## Install

```bash
pnpm add @harness-one/redis ioredis
```

## Peer Dependencies

- `ioredis` >= 5.0.0
- `harness-one` (workspace)

## Quick Start

```ts
import IORedis from 'ioredis';
import { createRedisStore } from '@harness-one/redis';

const client = new IORedis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: 3,
});

const store = createRedisStore({
  client,
  prefix: 'harness:memory',
  defaultTTL: 60 * 60 * 24, // 1 day
});

const entry = await store.write({
  key: 'user-preference',
  content: 'User prefers concise responses.',
  grade: 'useful',
  tags: ['preference'],
  metadata: { sessionId: 'session-abc' },
});

const entries = await store.query({ sessionId: 'session-abc' });
console.log(entries);

// Operator-only: scan and remove corrupt entries from the index
const { repaired } = await store.repair();
console.log(`Removed ${repaired} corrupt entries`);

await client.quit();
```

Pass a `logger: { warn }` to route diagnostics (corrupt JSON, schema mismatch) into a structured log pipeline. `repair()` is explicit and destructive — it is not invoked on normal reads.

See the main [repository README](../../README.md).
