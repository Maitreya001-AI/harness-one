# @harness-one/ajv

Ajv-backed `SchemaValidator` injectable into the harness-one tool registry. Replaces the built-in lightweight validator with full JSON Schema support (`$ref`, `oneOf`, `anyOf`, formats, custom keywords).

## Install

```bash
pnpm add @harness-one/ajv ajv
# Optional — enables format validators (email, uri, date-time, ...)
pnpm add ajv-formats
```

## Peer Dependencies

- `ajv` >= 8.0.0
- `ajv-formats` >= 3.0.0 (optional — format keywords are silently ignored when absent)
- `harness-one` (workspace)

## Quick Start

```ts
import { createAjvValidator } from '@harness-one/ajv';
import { createRegistry, defineTool, toolSuccess } from 'harness-one/tools';

const validator = createAjvValidator({ allErrors: true, formats: true });
const registry = createRegistry({ validator });

registry.register(
  defineTool<{ email: string }>({
    name: 'sendEmail',
    description: 'Send an email',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
      required: ['email'],
    },
    execute: async ({ email }) => toolSuccess({ sentTo: email }),
  }),
);
```

The validator caches compiled schemas in an LRU (`maxCacheSize`, default 256). Pass a `logger` to route non-fatal warnings.

See the main [repository README](../../README.md).
