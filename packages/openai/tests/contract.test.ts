/**
 * Adapter contract suite for `@harness-one/openai`.
 *
 * Runs the shared ~25-assertion contract suite from
 * `harness-one/testing` against a cassette-backed OpenAI adapter. The
 * cassettes under `tests/cassettes/` are the source of truth for this
 * run; the nightly `cassette-drift` workflow re-records them from a
 * live OpenAI key and opens an issue if the payloads diverge.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import OpenAI from 'openai';
import { describe, it, expect, beforeAll } from 'vitest';

import { createAdapterContractSuite } from 'harness-one/testing';

import { createOpenAIAdapter } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cassetteDir = resolve(__dirname, 'cassettes');

const adapter = createOpenAIAdapter({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'sk-test-cassette-only' }),
  model: 'gpt-4o-mini',
});

createAdapterContractSuite(adapter, {
  cassetteDir,
  label: '@harness-one/openai',
  testApi: { describe, it, expect, beforeAll },
});
