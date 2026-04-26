# dogfood Harness Log

> Continuous friction log. Every time a developer or operator hits a
> harness-one snag while working on or maintaining `apps/dogfood/`,
> append a new entry **at the top** (newest first).
>
> Format requirements live in
> [`docs/harness-one-app-feedback-loop.md`](../../docs/harness-one-app-feedback-loop.md)
> § "HARNESS_LOG.md (continuous friction log)". Entries that don't follow
> the format are pushed back rather than merged — "dev diary" style
> entries have zero feedback value.

---

(No entries yet. The artifact was added when the three-layer
architecture standardized app-level feedback. The first friction
encountered after that should land **above this paragraph**, using the
template below.)

---

## Entry template

```markdown
## YYYY-MM-DD — One-line title naming the API or behavior

**Friction**: Specific API, scenario, and what went wrong. Include a
minimal reproduction (5-15 lines) when possible.

**Current workaround**:
\`\`\`ts
// what we're doing today to ship around it
\`\`\`

**Feedback action**:
- [ ] Issue #
- [ ] PR #
- [ ] RFC docs/rfc/NNNN-xxx.md
- [ ] Pending evaluation (root cause not yet understood)
- [ ] Won't fix (reason: ...)

**Severity**: low / medium / high

**Suspected root cause** (optional): Where in harness-one the fix likely
needs to land + why.
```
