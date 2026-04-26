# HYPOTHESIS · 02-rag-support-bot

> Frozen before any Build code was written; observed annotations added
> as the showcase actually ran.

---

## ✅ Expected to be smooth

1. **Bag-of-words embedding produces meaningful retrieval order on
   short docs.** Confidence: high. Retriever is exercised by
   conformance kit.

   *Observed*: ✅ For "What does HTTP 429 mean", `429.md` ranks first
   at 0.327; `404.md` second at 0.283. Working as expected for keyword
   overlap.

2. **`createInjectionDetector` flags the obvious "ignore previous
   instructions"** pattern.

   *Observed*: ✅ Adversarial chunk dropped on every scenario where it
   appeared in retrieval results.

## ⚠️ Suspected to wobble

3. **Multi-tenant scoping with metadata-only tagging.** Will
   `retrieve({ tenantId: 'alpha' })` find `tenant: 'alpha'`-tagged
   chunks indexed via `index()`, or do they need `indexScoped()`?

   *Observed*: ⚠️ As suspected — `index()` ignores the tenant metadata
   field. Had to refactor to `indexScoped()` per tenant. Recorded as
   FRICTION #1.

4. **Adversarial chunk leaking into the answer.** Even if the
   guardrail correctly drops it, will the chunk content somehow
   influence the AgentLoop output?

   *Observed*: ✅ No leakage. The adversarial chunk is removed from
   the context block before it ever reaches the system prompt.

5. **Cross-tenant query that has no answer in the queried tenant.**
   If alpha's user asks about Postgres (which is in beta), the system
   should return a non-leak "I don't know" rather than embedding
   a beta chunk.

   *Observed*: ✅ Scenario 4 returns alpha's HTTP 200 doc as the
   highest-scoring (low quality match, all scores 0.000), but no beta
   doc leaks. Tenant isolation is hard.

## ❓ Genuinely unknown

6. **False-positive rate of `createInjectionDetector` on legitimate
   technical docs that mention "instructions" or "override".**

   *Observed*: ✅ None of the legitimate docs in this small corpus
   were dropped. But the corpus is curated; production docs about
   security topics would likely trip the detector. Future runs at
   higher sensitivity should measure this.

7. **Citation ordering when the top chunk is dropped by the guardrail.**
   Does `retrieve({ limit: 4 })` then drop-1 give us 3 ranked correctly,
   or does the dropped chunk's slot disappear silently with stale
   ranking on the rest?

   *Observed*: ✅ Stable ordering. Dropped chunk is removed; remaining
   chunks keep their original retrieval scores in citation order.
