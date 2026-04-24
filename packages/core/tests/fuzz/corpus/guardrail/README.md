# Guardrail input seed corpus

Short, hand-picked samples the O2 guardrail fuzz replays before its
property-based arbitraries. Each file is a raw UTF-8 blob suitable for
passing directly into a `GuardrailContext.content`.

| File | What it probes |
|------|----------------|
| `zero-width-injection.txt` | Zero-width space inside a hostile instruction |
| `rtl-injection.txt` | RTL override injection (U+202E) |
| `null-bytes.txt` | Stream of null bytes |
| `control-chars.txt` | BEL/VT/FF/ESC — low-ASCII control characters |
| `bidi-override.txt` | Bidi isolate + pop directional formatting |
| `homoglyph-prompt.txt` | Cyrillic homoglyphs spelling "ignore previous" |
| `html-entities.txt` | HTML-encoded instruction attempt |
| `null-payload.txt` | Empty content — the classic |
| `ascii-only.txt` | Baseline ASCII sample — must always pass |
| `tiny-unicode.txt` | Single combining character — normalization edge |

Large (10 MB) inputs are generated in the test itself rather than
committed, since they compress the same way either way and bloat git.
