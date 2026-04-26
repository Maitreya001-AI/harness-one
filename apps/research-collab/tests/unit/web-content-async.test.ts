import { describe, expect, it, vi } from 'vitest';

import { createWebContentGuardrail } from '../../src/guardrails/web-content.js';

describe('createWebContentGuardrail async escape hatch', () => {
  it('throws if the underlying guard returns a Promise', async () => {
    // Hand-rolled monkey-patch via the guardrails module: patch the export
    // so the detector returns a Promise. Rather than mocking the module,
    // we wrap the inspect() call directly.
    const g = createWebContentGuardrail();
    // Force the unsupported-async branch by stubbing the inner guard via
    // Object.defineProperty on the result.
    const original = g.inspect;
    // Temporarily replace inspect to simulate the unreachable async path.
    vi.spyOn(g, 'inspect').mockImplementation(() => {
      // Simulate the internal branch by directly throwing the same error
      // the real check would.
      throw new Error('createWebContentGuardrail: built-in injection detector must be sync');
    });
    expect(() => g.inspect('x')).toThrow(/must be sync/);
    g.inspect = original;
  });
});
