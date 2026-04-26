---
'harness-one': major
---

`CheckpointStorage` and `CheckpointManager` interfaces are now fully
async — every method returns `Promise<...>`.

**Why**: the previous sync interface composed badly with async
backends (HARNESS_LOG showcase 03 — `FsMemoryStore` is async, so
gluing it under `CheckpointStorage` required a write-through cache or
a `deasync`-style shim). The async migration lets fs-backed and
remote (Redis, S3, …) backends slot in directly.

**New backend** ships alongside: `createFsCheckpointStorage({ dir })`
from `harness-one/context`. Atomic-rename writes per checkpoint plus a
single `_index.json` for ordered `list()`. Recovers via directory
scan when the index is torn or missing. Tests exercise cold-restart
persistence, cross-process auto-prune, concurrent in-process writes,
and torn-index recovery.

**Migration**:

```diff
- const cp = mgr.save(messages, 'label');
- const restored = mgr.restore(cp.id);
- const list = mgr.list();
- mgr.dispose();
+ const cp = await mgr.save(messages, 'label');
+ const restored = await mgr.restore(cp.id);
+ const list = await mgr.list();
+ await mgr.dispose();
```

Custom `CheckpointStorage` implementations must update their methods
to return Promises. The default in-memory storage is unchanged
behaviourally — Promise-wrapped sync ops, no IO cost.
