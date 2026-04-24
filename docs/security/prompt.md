# Prompt · Threat Model

> Multi-layer prompt assembly, versioned template registry, disclosure
> manager. Sits between host configuration and the LLM — a miscompile
> here can leak secrets into the cache-stable prefix or turn a template
> into a vector for indirect prompt injection.

## Trust boundaries

- **Template source** — when the registry is backed by a remote
  `PromptBackend` (Langfuse, a custom store), templates are
  attacker-reachable if the upstream is compromised.
- **Template variables** — values are user / upstream-supplied; the
  `{{var}}` substitution path is the largest substitution surface we
  own.
- **Host code** — trusted. Calls `createPromptBuilder`, assembles
  layers, sets variables.
- **LLM output** — not consumed by this subsystem but influenced by it
  (template shapes the prompt).

## STRIDE

### Spoofing

- **Threat**: Forged `PromptTemplate` with a mismatched `version` or an
  `id` overlap smuggled through `register()`.
  - Mitigation: `validateSemver()` rejects non-numeric version strings;
    re-registering a version without `force: true` triggers a `warn`
    hook so operators see the overwrite.
  - Evidence: `packages/core/src/prompt/registry.ts:50-57`,
    `packages/core/src/prompt/registry.ts:161-168`.

### Tampering

- **Threat**: Variable value contains a nested `{{other}}` that expands
  recursively, pulling in a secret from a shared variable bag.
  - Mitigation: The default `sanitize: true` path strips `{{…}}` from
    injected values before they reach the template body (builder
    replaces with empty string; registry keeps the inner name only).
  - Evidence: `packages/core/src/prompt/builder.ts:66-72`,
    `packages/core/src/prompt/registry.ts:38-42`.

- **Threat**: A layer added after build is read from the cached
  result, silently serving stale content.
  - Mitigation: `addLayer` / `removeLayer` / `setVariable` all set the
    `dirty` flag and invalidate `cachedResult` + `cachedPrefixHash`.
  - Evidence: `packages/core/src/prompt/builder.ts:93-112`.

### Repudiation

- **Threat**: A template is silently overwritten by an upstream push,
  with no log of what changed.
  - Mitigation: Overwrite path emits `logger.warn` with the
    `{id, version}` pair unless the caller passes `force: true`.
  - Evidence: `packages/core/src/prompt/registry.ts:161-168`.

### Information Disclosure

- **Threat**: A variable bag shared across prompts contains a secret
  that the current template did not reference; the secret leaks because
  the builder naively concatenates bag entries.
  - Mitigation: Substitution is driven by the `{{var}}` regex in the
    template body — undeclared variables are never inlined. O4 fuzz
    "does not leak variable values that the template never referenced"
    exercises this invariant on 2000 random bodies.
  - Evidence: `packages/core/src/prompt/builder.ts:63-74`,
    `packages/core/tests/fuzz/prompt-template.fuzz.test.ts`.

- **Threat**: `getStablePrefixHash()` returns a hash derived from
  variable-substituted content, causing KV-cache invalidation on every
  variable change and reducing cache hit rate — not a disclosure but a
  nearby issue.
  - Mitigation: Hash is computed over *raw* cacheable content, before
    variable substitution, so cache prefix is stable across renders.
  - Evidence: `packages/core/src/prompt/builder.ts:120-126`.

### Denial of Service

- **Threat**: `removeExpired()` is called repeatedly on a registry with
  tens of thousands of versions, causing an O(n²) recompute of
  `latestVersions`.
  - Mitigation: Recompute of latest version only happens when an id's
    current latest is deleted; for unaffected ids the inner loop is a
    no-op. Not a hard cap, but the `compareSemver` loop is O(segments)
    per version.
  - Evidence: `packages/core/src/prompt/registry.ts:246-256`.

- **Threat**: Registry accepts unbounded template content size.
  - Status: Unmitigated — tracked in issue #TBD. Callers are expected
    to size-bound templates at the `PromptBackend` boundary. The
    registry itself does not enforce a `maxTemplateBytes` cap.

### Elevation of Privilege

- **Threat**: A template declares `variables: ['constructor']` or
  `variables: ['toString']`; the registry's missing-variable check
  walks the prototype chain and throws `TypeError` instead of
  `PROMPT_MISSING_VARIABLE`. A hostile prompt author could reliably
  crash the resolver.
  - Mitigation: Own-property check
    `Object.prototype.hasOwnProperty.call(variables, varName)` rejects
    prototype-chain keys before the substitution runs. Fuzz-discovered
    (F-O4-01, closed); regression covered by
    `packages/core/src/prompt/__tests__/registry.test.ts` describe block
    `F-O4-01: prototype-chain variable names`.
  - Evidence: `packages/core/src/prompt/registry.ts:31-37`.

## Residual risks

- Disclosure manager (`disclosure.ts`) controls which layers flow into
  the final prompt based on an integer tier. A bug in the tier
  assignment by host code could expose an internal "staff" tier to an
  anonymous user. The subsystem cannot validate host-assigned tiers.
- Backends that implement `push(template)` are semver-validated on
  `register` but not on the `fetch` return. A compromised backend can
  ship any content — defence of this boundary is the backend's job.

## References

- `docs/architecture/02-prompt.md`
- `docs/architecture/14-advanced.md` (PromptBuilder re-export)
- `packages/core/tests/fuzz/prompt-template.fuzz.test.ts` — O4 coverage
- `packages/core/tests/fuzz/FINDINGS.md` — F-O4-01
