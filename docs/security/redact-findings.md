# Redact pipeline — adversarial-test findings (April 2026)

The adversarial test file at
`packages/core/tests/security/redact-adversarial.test.ts` exercises the
`sanitizeAttributes` / `redactValue` pipeline against 23 realistic
secret-shaped values plus four nested/truncated/array shapes. Three of
those cases are marked `[known-gap]` — the current redactor does not
catch them, and the tests document the gap rather than assert a fix.

Per track-M discipline, none of these gaps are fixed in this PR. Each
becomes an independently filable issue for the maintainers to triage.

## Gap 1 — camelCase keys without a separator

`DEFAULT_SECRET_PATTERN` in `packages/core/src/infra/redact.ts` anchors
every matched keyword with `(^|[._-])` on the left and `([._-]|$)` on
the right. A key like `apiToken` has no separator between the `api`
segment and the `token` segment, so:

- `api[_-]?key` does not match (no `key`).
- `token` does not match (the `T` is not preceded by `^`, `.`, `_`, or `-`).

Consequence: an `apiToken` attribute passes through to logs/traces
unmasked. The same failure mode affects any camelCase secret-shaped
key that fuses two otherwise-matched words (e.g. `accessToken`,
`authKey`, `bearerCredential`).

**Recommended fix**: extend the boundary class to include a lowercase-
to-uppercase transition, or add explicit camelCase alternatives
(`apiToken`, `accessToken`, …). A regex-level fix is simpler; an AST
walk over the key is more robust.

## Gap 2 — secrets embedded in URL values

A URL value stored under a non-secret key (e.g. `url`, `endpoint`,
`link`) can carry an API key in its query string:

```
https://api.example.com/v1/things?api_key=sk-ant-ZZZ…
```

The redactor looks only at keys, so the secret survives into the
exported span/log.

**Recommended fix**: add a value-level post-pass that regex-matches
common secret shapes (JWTs, `sk-ant-…`, `ghp_…`, etc.) inside string
values. This is strictly additive — the key-based fast path stays —
so the performance cost is bounded to strings that the key-based pass
did not already redact.

## Gap 3 — JSON blobs embedded in string fields

A raw-body field like `body` or `payload` containing a JSON string
`{"Authorization":"Bearer sk-ant-…"}` is treated as one opaque string.
The redactor does not attempt to re-parse it, so the embedded
`Authorization` header is preserved.

**Recommended fix**: same as Gap 2 — a value-level secret scanner —
plus an optional "try to JSON.parse" step for fields named like
`body` / `payload` / `response`.

---

## Not gaps (positive verifications)

For completeness, the test file also verifies that the redactor DOES
correctly catch:

- `sk-ant-…` Anthropic keys under `api_key`.
- `sk-…` OpenAI keys under `apiKey`, `openai_api_key`.
- AWS `AKIA…` / `ASIA…` access keys.
- GitHub `ghp_` / `gho_` / `ghs_` tokens under `authorization` / `token`.
- JWTs, PEM private-key blocks, bcrypt-ish password hashes.
- Multi-line secrets, CJK / utf-8 noise.
- Deeply nested (4 levels) and array-indexed placements.
- Prototype-polluting keys (`__proto__`, `constructor`, `prototype`).

These are regression guards — if a future edit to the regex weakens
any of the above, CI goes red.
