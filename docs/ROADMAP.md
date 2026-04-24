# harness-one public roadmap

This is the living roadmap. It tells you what is shipped, what is next, and
why. Dates are directional; scope is the contract.

- **v0.x** — pre-1.0. Any minor bump may break consumers; every break is
  captured in [`MIGRATION.md`](../MIGRATION.md).
- **v1.0** — public API frozen for the `harness-one` barrel and every
  `harness-one/<subpath>` the `api-extractor` snapshots cover. Breaking
  changes require a new major.

If a line below is wrong or stale, open an issue labelled `roadmap` — the
maintainers would rather re-negotiate it than ship a false promise.

---

## Shipped · v0.1 (current)

Every box below has a CI workflow or a directory of tests as evidence.

### Library correctness (layers 1–15 of the testing blueprint)

- **Layer 1 Unit** — `packages/*/src/**/__tests__` with coverage thresholds
  (lines/statements 80, branches 75).
- **Layer 2 Integration** — `packages/core/src/__tests__/integration.test.ts`,
  `packages/preset/src/__tests__/integration.test.ts`, and the multi-agent
  integration test under `packages/core/src/orchestration/__tests__`.
- **Layer 3 Contract** — `createAdapterContractSuite` in
  `packages/core/src/testing/contract/`, driven from
  `packages/anthropic/tests/contract.test.ts` and
  `packages/openai/tests/contract.test.ts`.
- **Layer 4 Property-based** — eight fast-check suites covering backoff,
  LRU cache, conversation pruner, pricing, stream aggregator, agent-loop
  state machine, file-system store, and cost tracker.
- **Layer 5 Cassette** — record / replay adapter harness under
  `packages/core/src/testing/cassette/`; nightly drift detection via
  `.github/workflows/cassette-drift.yml`.
- **Layer 6 Chaos** — `packages/core/tests/chaos/h1…h5` cover rate limiting,
  stream break, tool-arg bloat, hang timeout, and malformed JSON.
- **Layer 7 Perf baseline** — `packages/core/tests/perf/` with a checked-in
  baseline (`baseline.json`) and ±15% drift gate (`.github/workflows/perf.yml`).
- **Layer 8 Examples-as-tests** — `tools/run-examples.mjs` + `check:readme`
  snippet extractor run in CI.
- **Layer 9 Dogfood** — `apps/dogfood/` (Issue Triage Bot) plus the three
  differentiated showcases under `examples/showcases/`. See [Showcases] in
  the README.
- **Layer 10 Security** — `audit.yml`, `scorecard.yml`, `secret-scan.yml`,
  `sbom.yml`, `fuzz.yml`, and 12 STRIDE threat-model docs in
  `docs/security/`.
- **Layer 11 Type-level** — seven `.test-d.ts` files with `expect-type`
  under `packages/core/tests/type-level/`.
- **Layer 12 DX** — `size-limit` gate, tree-shake verifier, error-message
  lint (`tools/lint-error-messages`), TSDoc lint (`tools/lint-tsdoc`).
- **Layer 13 Docs** — `lychee` link checker, `typedoc` build, 10 ADRs
  under `docs/adr/`.
- **Layer 14 Mutation** — Stryker with a 80% break threshold, weekly run
  via `.github/workflows/mutation.yml`.
- **Layer 15 Release** — reproducible `pnpm pack`, SLSA provenance, OIDC
  trusted publisher, SBOM attached to every Release.
- **Cross-version** — peer-dep compat matrix and migration-path executor
  (`compat-matrix.yml`, `migrations.yml`).
- **Community** — LICENSE, CODE_OF_CONDUCT, CONTRIBUTING, SECURITY,
  CODEOWNERS, issue / PR templates, SECURITY private-disclosure flow,
  OSSF self-assessment, public ROADMAP (this file).

---

## Next · v0.2 (target: one month after v0.1 GA)

Driven by dogfood + first-user feedback, not speculation.

### New provider adapters

- **`@harness-one/gemini`** — at parity with Anthropic / OpenAI on the
  contract suite (layer 3). Cassettes + nightly drift.
- **`@harness-one/bedrock`** — the enterprise checkbox adapter; only
  merges once it passes the same contract suite as the other two.

### Dogfood-signal-driven fixes

- Any error code that shows up ≥ 3 times in `dogfood-reports/weekly-*.md`
  is triaged in the following release — each gets an ADR entry if the fix
  alters a public contract.

### Compat-matrix expansion

- Node 24 leg in CI the week it goes GA (no hand-waving on `engines`).
- TS 5.7 added to the type-level matrix.

### English-first docs pass

- Every doc under `docs/` and both READMEs audited for phrasing so the
  English text stands on its own — today some English files read like
  translations.

### Observability ergonomics

- First-class Langfuse + OTel quickstart under `examples/observe/` with
  a two-file recipe each.

---

## Then · v1.0 (target: when all of the following hold)

### API freeze

- `api-extractor` snapshot for every workspace package is byte-stable
  against the previous minor.
- ADRs 0001–0010 are reaffirmed or explicitly superseded — no silent
  re-interpretation of `fail-closed`, `zero-runtime-deps`, or the
  `AgentAdapter` contract.

### Supply-chain maturity

- **SLSA 3+** on every published tarball. Today we attest Level 1; the
  build must be hermetic and non-falsifiable to reach 3.
- **OpenSSF Best Practices** upgrade from Passing to Silver. Passing is
  the v0.1 entry; Silver requires documented security review, coding
  guidelines, and a cleared vulnerability-response SLA.

### Governance

- Public RFC process for breaking changes (`docs/rfc/NNNN-title.md`).
- Supported version policy: two minor versions receive security backports
  for the life of the major.
- At least one maintainer outside the founding author — reviewable in
  `.github/CODEOWNERS`.

### Quality bar

- Mutation score ≥ 80% across `packages/core/{core,guardrails,infra}`.
- Dogfood agent has run continuously for eight weeks with no silent
  failure that required a retroactive fix in `apps/dogfood/`.
- At least one external production user has shipped harness-one behind a
  public product and contributed a non-trivial PR.

---

## How to influence the roadmap

- Open an issue labelled `roadmap-request` with a use case, not a
  feature. "We can't ship X because harness-one doesn't do Y" is the
  shape we act on.
- Vote on existing issues with reactions — we read them monthly.
- For security-sensitive asks, follow [`SECURITY.md`](../SECURITY.md).

Breaking the rules above requires a matching ADR. "Exception today, rule
tomorrow" is not a roadmap item; it's a bug.
