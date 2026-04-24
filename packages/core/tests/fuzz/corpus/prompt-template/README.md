# Prompt-template seed corpus

Template bodies + variable bags the O4 fuzz replays before the
property-based phase. Each pair probes one placeholder-injection
attempt a hostile prompt author or compromised upstream prompt store
could plant.

All 10 entries live in `cases.json` as a JSON array; each object
declares `{ name, template, variables, mustContain?, mustNotContain? }`.
One file avoids creating 20 tiny `.tmpl` / `.json` pairs for what are
all small string bodies.

| Pair | What it probes |
|------|----------------|
| `nested-braces` | `{{{{x}}}}` — double-wrapped placeholder |
| `env-var-injection` | `${process.env.SECRET}` in a variable value |
| `path-traversal` | `{{../../system}}` — path-like var name |
| `recursive-expansion` | Variable value contains another `{{var}}` token |
| `unicode-var` | Unicode characters around braces |
| `missing-var-leak` | Variable reference with no matching value |
| `template-literal` | `` `${expr}` `` JS template-literal syntax |
| `html-breakout` | `</system>` HTML-ish breakout attempt |
| `eval-attempt` | `constructor.constructor('return this')()` as a value |
| `circular-ref` | Variable whose value names the same variable |

These exist to catch regressions in `{{var}}` substitution, not to
exhaustively cover every possible injection — the fast-check arbitraries
do that.
