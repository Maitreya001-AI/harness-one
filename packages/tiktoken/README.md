# @harness-one/tiktoken

Tiktoken tokenizer registration for `@harness-one/context`. Provides exact BPE token counts for supported models, replacing the built-in heuristic estimator.

## Install

```bash
pnpm add @harness-one/tiktoken tiktoken
```

## Peer Dependencies

- `tiktoken` >= 1.0.0
- `harness-one` (workspace)

## Quick Start

```ts
import { registerTiktokenModels, createTiktokenTokenizer, disposeTiktoken } from '@harness-one/tiktoken';
import { countTokens } from 'harness-one/context';

// Register defaults: gpt-4, gpt-4o, gpt-4o-mini, gpt-3.5-turbo
registerTiktokenModels();

// Or register specific models:
// registerTiktokenModels(['gpt-4o', 'gpt-4o-mini']);

// Or obtain a single tokenizer directly:
const tokenizer = createTiktokenTokenizer('gpt-4o');
console.log(tokenizer.encode('hello world').length); // 2

// countTokens() now returns exact counts for registered models
console.log(countTokens('gpt-4o', [{ role: 'user', content: 'hello world' }]));

// Free WASM memory on shutdown (optional but recommended for long-running hosts)
disposeTiktoken();
```

`registerTiktokenModels()` is idempotent — repeated no-arg calls are no-ops once defaults are registered. Encoders are cached per model; call `disposeTiktoken()` to release the underlying WASM allocations before process exit or a graceful reload.

See the main [repository README](../../README.md).
