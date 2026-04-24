# Redact pipeline — adversarial-test findings

The adversarial test file at
`packages/core/tests/security/redact-adversarial.test.ts` exercises the
`sanitizeAttributes` / `redactValue` pipeline against 24 realistic
secret-shaped values plus four nested/truncated/array shapes. Two
cases are marked `[known-gap]` — the current redactor cannot catch
them, and the tests document the gap rather than assert a fix.

## Gap 1 — secrets embedded in URL values

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

## Gap 2 — JSON blobs embedded in string fields

A raw-body field like `body` or `payload` containing a JSON string
`{"Authorization":"Bearer sk-ant-…"}` is treated as one opaque string.
The redactor does not attempt to re-parse it, so the embedded
`Authorization` header is preserved.

**Recommended fix**: same as Gap 1 — a value-level secret scanner —
plus an optional "try to JSON.parse" step for fields named like
`body` / `payload` / `response`.

---

## Fixed in this PR

- **camelCase keys without separator** (`apiToken`, `accessToken`, …).
  The redactor now normalises camelCase boundaries by inserting `-` at
  each lower→upper transition before the regex test, so keys like
  `apiToken` are matched as if they were written `api-Token`. Covered
  by two regression tests in the adversarial suite.

---

## Positive verifications (regression guards)

The test file verifies that the redactor DOES correctly catch:

- `sk-ant-…` Anthropic keys under `api_key`.
- `sk-…` OpenAI keys under `apiKey`, `openai_api_key`.
- AWS `AKIA…` / `ASIA…` access keys.
- GitHub `ghp_` / `gho_` / `ghs_` tokens under `authorization` / `token`.
- JWTs, PEM private-key blocks, bcrypt-ish password hashes.
- Multi-line secrets, CJK / utf-8 noise.
- Deeply nested (4 levels) and array-indexed placements.
- Prototype-polluting keys (`__proto__`, `constructor`, `prototype`).
- camelCase composites `apiToken` / `accessToken` (see above).

If a future edit to the regex weakens any of the above, CI goes red.
