import { describe, expect, it } from 'vitest';

describe('package smoke', () => {
  it('module graph loads barrel files', async () => {
    await expect(import('../../src/agent/index.js')).resolves.toBeDefined();
    await expect(import('../../src/tools/index.js')).resolves.toBeDefined();
    await expect(import('../../src/guardrails/index.js')).resolves.toBeDefined();
    await expect(import('../../src/config/index.js')).resolves.toBeDefined();
  });
});
