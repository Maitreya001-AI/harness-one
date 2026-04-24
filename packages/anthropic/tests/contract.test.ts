/**
 * Adapter contract suite for `@harness-one/anthropic`.
 *
 * Runs the shared ~25-assertion contract suite from
 * `harness-one/testing` against a cassette-backed Anthropic adapter.
 * The cassettes under `tests/cassettes/` are the source of truth for
 * this run; the nightly `cassette-drift` workflow re-records them
 * from a live Anthropic key and opens an issue if the payloads
 * diverge.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { describe, it, expect, beforeAll } from 'vitest';

import { createAdapterContractSuite } from 'harness-one/testing';

import { createAnthropicAdapter } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cassetteDir = resolve(__dirname, 'cassettes');

// A stubbed client — the contract suite in `replay` mode never actually
// invokes it (the real SDK is only used during `record` mode). Using a
// dummy key means a missing `ANTHROPIC_API_KEY` doesn't break the
// offline test path.
const adapter = createAnthropicAdapter({
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test-cassette-only' }),
  model: 'claude-3-5-haiku-20241022',
});

createAdapterContractSuite(adapter, {
  cassetteDir,
  label: '@harness-one/anthropic',
  testApi: { describe, it, expect, beforeAll },
});
