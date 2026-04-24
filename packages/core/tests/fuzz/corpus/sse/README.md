# SSE corpus

Raw SSE wire-format samples replayed through a minimal
line-and-buffer decoder (embedded in `sse-stream-parser.fuzz.test.ts`).
The decoder mirrors the spec from
https://html.spec.whatwg.org/multipage/server-sent-events.html so we can
assert harness-one's outbound SSE (`toSSEStream` + `formatSSE`) is
decoder-safe and that known malformed inbound frames don't throw when
run through a consumer-side loop that downstream applications might
build.

| File | What it probes |
|------|----------------|
| `bare-event.txt` | `event:` with no value followed by data |
| `data-multiline.txt` | `data:` line repeated — must concatenate |
| `crlf-mix.txt` | Alternating `\r\n` / `\n` line endings |
| `bom-prefix.txt` | UTF-8 BOM before the first field |
| `huge-gap.txt` | Many blank lines between events |
| `half-line-eof.txt` | Stream ends mid-line with no terminator |
| `comment-only.txt` | `:` comment lines with no event |
| `retry-field.txt` | `retry:` field with non-integer value |
| `unknown-field.txt` | Arbitrary field name the spec says to ignore |
| `empty-frame.txt` | Double blank line (empty event) |
| `very-long-data.txt` | Single `data:` line > 64 KB |
| `mixed-fields.txt` | Mix of legal and illegal fields |
| `ctrl-chars-in-data.txt` | Embedded BEL / NUL / VT inside a data value |
| `id-then-nothing.txt` | `id:` field then EOF (no dispatch) |
| `nested-data-newlines.txt` | Multiple `data:` lines separated by `\n` |

Add samples here whenever a real-world SSE stream trips the
`StreamAggregator` or a downstream SDK parser — not the test file itself.
