# HYPOTHESIS · 03-memory-checkpoint-stress

> Frozen before any Build code was written; observed annotations added
> as the showcase actually ran.

---

## ✅ Expected to be smooth

1. **`FsMemoryStore.write` is durable across an immediate crash.** The
   docs say writes use atomic rename. After SIGKILL we should see all
   pre-crash entries on disk.

   *Observed*: ✅ Confirmed. 30 / 30 entries persisted across 2
   SIGKILLs. No partial entries left behind.

2. **`_index.json` survives an interrupted batch update.** Writes are
   per-entry atomic; the index is updated separately but also via
   atomic rename.

   *Observed*: ✅ No `STORE_CORRUPTION` thrown on restart in any
   segment. Index successfully reloaded after each crash.

3. **Iteration ordering is preserved.** Storage isn't a sorted set,
   but iterating by tag returned all entries in the order we cared
   about (we sort by `metadata.iteration` on read).

   *Observed*: ✅ Iteration map fully populated after all segments
   complete.

## ⚠️ Suspected to wobble

4. **Crash signal observability through wrappers.** The `child_process`
   docs are clear that `signal` is only set when the immediate child
   dies from the signal. With pnpm + tsx wrappers in between, this
   chain is broken.

   *Observed*: ⚠️ As suspected. Required workaround: also accept exit
   code 137 as evidence of SIGKILL. Recorded in FRICTION #2.

5. **`CheckpointManager` + `FsMemoryStore` composition.** The PLAN
   prose lumps these together as if they share a backend.

   *Observed*: ⚠️ They don't compose. CheckpointStorage is sync,
   MemoryStore is async. Recorded in FRICTION #3 — material design
   issue, escalated to RFC candidate.

## ❓ Genuinely unknown

6. **High-frequency writes (many small entries) vs the index lock.**
   30 sequential writes is a tiny load. Does the per-process index
   lock serialize cleanly or contend? Hard to feel without a parallel
   workload.

   *Observed*: at 30 sequential writes, no contention. A future
   200-entry, parallel-write variant would actually exercise this.

7. **What happens if SIGKILL lands DURING the index rename?** POSIX
   rename is atomic, but the moment between "old data flushed to fsync"
   and "rename completes" is racy on some filesystems.

   *Observed*: 0 corruption seen in 2 crashes, so no signal here. To
   actually probe this we'd need to inject crashes in a tight loop
   (hundreds of attempts) since the race window is narrow. Out of
   MVP scope.
