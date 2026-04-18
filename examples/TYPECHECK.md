# examples/ typecheck policy

`pnpm -C examples typecheck` runs `tsc --noEmit` under the same strictness
as the root base config, with two relaxations:

- `noImplicitAny: false` — so examples can demo optional peer deps without
  forcing the reader to install every provider SDK.
- `exactOptionalPropertyTypes: false` — matches the ergonomic pattern most
  downstream adopters will use.

All files compile. Unresolved provider SDK imports are modelled via
`shims.d.ts` (ambient `declare module '…'` blocks typed as `any`) so
`@anthropic-ai/sdk`, `openai`, `langfuse`, `ioredis`, `tiktoken`,
`@opentelemetry/api`, `@pinecone-database/pinecone`, `ajv` and friends
can be demoed without installing them. If a reader adds the real peer
dep, their editor picks up the real types in place of the shim.

Add a new example: drop it anywhere under `examples/`, run
`pnpm -C examples typecheck`, and fix any red squigglies. No
`tsconfig.json` `exclude` list to maintain.
