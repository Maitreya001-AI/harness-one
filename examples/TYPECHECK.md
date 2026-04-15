# examples/ typecheck policy

`pnpm -C examples typecheck` runs `tsc --noEmit` under the same strictness as
the root base config, with two relaxations:

- `noImplicitAny: false` — so examples can demo optional peer deps (`ioredis`,
  `ajv`, `langfuse`, etc.) without forcing the reader to install them.
- `exactOptionalPropertyTypes: false` — matches the ergonomic pattern most
  downstream adopters will use.

Several files are excluded from the initial baseline (see `tsconfig.json`
`exclude` list). They have a mix of:

1. External peer-dep imports that aren't installed (`ioredis`, `ajv`,
   `langfuse`, `@opentelemetry/api`, `tiktoken`, `@pinecone-database/pinecone`).
2. Pre-existing API drift against core/observe/memory/orchestration introduced
   after the example was written.

These exclusions were introduced in Wave-5C PR-2 (T-2.11b) to establish a
green baseline *only* so the PR-2 subpath migration (T-2.12) cannot regress
anything. They should be revisited and narrowed during Wave-5D or 5E when the
examples are rewritten against the finalised barrel surface.
