# Tool-args seed corpus

Known-bad samples the O1 tool-arguments fuzz target replays before running
the property-based generators. Each file is one JSON-encoded argument
string a malicious or buggy model could emit. They are kept small and
committed so regressions are caught by the cheap pre-roll.

| File | What it probes |
|------|----------------|
| `proto-pollution-proto.json` | `{"__proto__": {...}}` — prototype poisoning |
| `proto-pollution-constructor.json` | `{"constructor": {"prototype": {...}}}` |
| `number-edges.json` | MAX_SAFE_INTEGER+1, tiny/huge exponents, `-0`, duplicate keys |
| `bom-prefixed.json` | UTF-8 BOM before the document — RFC-invalid but LLMs emit it |
| `unclosed-string.json` | Unterminated string — SyntaxError that must not leak |
| `lone-surrogate.json` | Lone high surrogate inside a string |
| `empty.json` | Empty document |
| `not-json.json` | Markdown code block instead of raw JSON |
| `big-string.json` | Single JSON string value ~200 chars — small byte-budget probe |
| `escaped-unicode.json` | Escaped BOM + non-character + astral emoji in value |
| `trailing-comma.json` | Trailing comma — not legal JSON; must not stack-crash |

Depth-based DoS samples (`deep-array`, `deep-object`) are synthesised in
the test itself — a committed 1000-level nested document would bloat the
diff and doesn't benefit from being read as a static file.

Add new samples here when fuzzing discovers a real bug; never inline the
sample into the test file. Keeping them on disk gives us a path to share
them with `@harness-one/ajv` or adapter packages later.
