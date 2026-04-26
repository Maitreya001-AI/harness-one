# Showcase 02 · RAG Support Bot

A single-turn RAG support bot that exercises **`rag` (multi-tenant
indexing)**, **`guardrails` (injection detection on retrieved chunks)**,
**`context` (chunks → system prompt)**, and **`core` (AgentLoop with a
mock reader)**.

## What it proves (pressure points)

- Tenant `alpha` and tenant `beta` indexes are disjoint — alpha
  questions never receive beta documents
- A prompt-injection chunk inside tenant alpha's corpus is dropped by
  the injection guardrail before reaching the AgentLoop
- The dropped chunk does not appear in the answer's citation list
- When the queried tenant has no covering document, the bot returns a
  low-confidence pointer rather than leaking from another tenant
- Every scenario produces structured citations with `file:line` +
  retrieval score

## Run

```bash
pnpm start
```

Exits 0 on full pass, 1 on any scenario failure (so `examples:smoke` /
CI can gate it).

## Files

| Path | Purpose |
|---|---|
| `src/main.ts` | RAG pipeline + guardrail + reader + assertions |
| `src/fixtures.ts` | Two tenant corpora + one adversarial chunk + scenario list |
| `PLAN.md` | Stage 1 — pressure points, success criteria, non-goals |
| `HYPOTHESIS.md` | Stage 2 — predictions made before code, with observed annotations |
| `FRICTION_LOG.md` | Stage 3 — accumulating friction encountered while building |

## Status

MVP complete. 4 / 4 scenarios pass on the deterministic embedding +
mock reader. Stages still pending:

- [ ] Stage 4 — Observe: ≥10 real-API runs (need `ANTHROPIC_API_KEY`)
- [ ] Stage 5 — Harvest, Stage 6 — FeedBack, Stage 7 — Archive

## Friction logged

3 entries in [`FRICTION_LOG.md`](./FRICTION_LOG.md):

1. Multi-tenant indexing needs `indexScoped()` (medium — silent zero
   results was the failure mode)
2. `runInput` verdict shape needs `'reason' in verdict` runtime check
   (low)
3. Chunk `id` is extended (`_chunk_N`); citations need to read
   `metadata` (trivial)
