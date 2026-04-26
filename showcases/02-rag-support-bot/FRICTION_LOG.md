# FRICTION_LOG · 02-rag-support-bot

> Per `docs/harness-one-showcase-method.md` Stage 3 rule 2: every time
> we work around / get stuck on harness-one, append a timestamped entry
> immediately.

---

## 2026-04-26 — Multi-tenant indexing requires `indexScoped()`, not `index()` + tenant in metadata

**Friction**: Initial mental model was "tag chunks with `tenant`
metadata, retrieve with `{tenantId}`, scoping happens automatically".
Real API splits this: `indexScoped(chunks, tenantId)` is a separate
method on `Retriever`. Calling `index()` with tenant-tagged chunks then
`retrieve({ tenantId: 'alpha' })` returns nothing because the
in-memory implementation looks up the tenant partition, not the
metadata field.

**Workaround**: Group chunks by tenant before indexing, call
`indexScoped()` per tenant.

**Feedback action**:
- [ ] Doc: `RetrieveOptions.tenantId` JSDoc says "Per-tenant cache
      partition key for retrievers that support it" — add a sentence
      pointing to `indexScoped()` and explain that metadata `tenant`
      tags are NOT auto-detected. The relationship is only obvious
      after reading the conformance kit.
- [ ] Consider: a higher-level helper that indexes from a flat list
      and reads tenant from a configurable metadata field. Three out
      of three of my mental-model attempts reached for this.

**Severity**: medium — silently zero-result retrieves is the worst
failure mode (no error, just an empty answer that looks like "we don't
have that info"). Could erode trust in RAG quietly.

**Suspected root cause**: The two API surfaces (metadata-based vs
partition-based) reflect two valid design choices. The
in-memory retriever picked partition; ergonomics of the metadata path
were never wired in. Documentation closes the gap cheaper than code.

---

## 2026-04-26 — `runInput` verdict shape requires runtime `'reason' in verdict.verdict` check

**Friction**: To print the rejection reason needed
`'reason' in verdict.verdict ? verdict.verdict.reason : 'policy violation'`
because the `verdict` discriminated union widens after `passed: false`
and TypeScript can't narrow to `reason` automatically without the in-check.

**Workaround**: The runtime check pattern works but is verbose at every
call site that wants a human-readable reason.

**Feedback action**:
- [ ] Consider: a `verdict.reason` accessor or a tiny
      `getRejectionReason(verdict)` helper that always returns a string.
      Three different files in the showcase work would now repeat the
      same `'reason' in ...` dance.
- [ ] Doc: add a "common patterns" snippet showing the right way to
      pull a printable reason out of a guardrail block.

**Severity**: low

---

## 2026-04-26 — `chunker.chunk(d).id` extension hides file:line metadata

**Friction**: After chunking, the chunk `id` becomes
`{originalDocId}_chunk_{n}` (e.g.
`alpha/docs/http/_adversarial.md#L1_chunk_0`). Citation rendering
that wanted just the original `file:line` had to dig into
`chunk.metadata` instead of using `chunk.id`.

**Workaround**: Pull file/line from `chunk.metadata` (which is
preserved from the source document by the chunker).

**Feedback action**: None — this is the right design. Chunks are
distinct from documents and need their own ids. The friction is just
that examples should always show pulling from metadata.

**Severity**: trivial

---

## (Append new entries above this line — newest first.)
