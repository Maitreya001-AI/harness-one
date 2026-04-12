---
"@harness-one/preset": major
---

**Breaking**: rename `harness-one-full` → `@harness-one/preset`.

The package has moved to the `@harness-one` npm scope to match every
other integration (`@harness-one/anthropic`, `@harness-one/openai`,
`@harness-one/redis`, etc.) and to signal that it's a convenience
**preset** rather than a superset library.

### Migration

```diff
- npm uninstall harness-one-full
+ npm install @harness-one/preset
```

```diff
- import { createHarness } from 'harness-one-full';
+ import { createHarness } from '@harness-one/preset';
```

No runtime behavior changes — this is a rename only. All
`createHarness(config)` call sites, returned `Harness` APIs, and the
`harness.run()` generator remain identical to `harness-one-full@0.2.0`.
