/**
 * ARCH-003: `harness-one/essentials` resolves to the same primitives as the
 * root barrel + their respective submodules. Pin both:
 *  1. Every essential symbol is importable as a function/class.
 *  2. The exported AgentLoop is reference-equal to the one from the root.
 */

import { describe, it, expect } from 'vitest';
import * as essentials from '../essentials.js';
import * as root from '../index.js';

describe('harness-one/essentials (ARCH-003)', () => {
  it('exports exactly the curated 12 symbols', () => {
    const expected = new Set([
      'AgentLoop',
      'createAgentLoop',
      'HarnessError',
      'MaxIterationsError',
      'AbortedError',
      'defineTool',
      'createRegistry',
      'createTraceManager',
      'createLogger',
      'createSessionManager',
      'createMiddlewareChain',
      'createPipeline',
    ]);
    const actual = new Set(Object.keys(essentials));
    expect(actual).toEqual(expected);
  });

  it('AgentLoop import resolves to the same value as the root barrel', () => {
    expect(essentials.AgentLoop).toBe(root.AgentLoop);
    expect(essentials.createAgentLoop).toBe(root.createAgentLoop);
  });

  it('every essential export is callable', () => {
    expect(typeof essentials.AgentLoop).toBe('function');
    expect(typeof essentials.createAgentLoop).toBe('function');
    expect(typeof essentials.defineTool).toBe('function');
    expect(typeof essentials.createRegistry).toBe('function');
    expect(typeof essentials.createTraceManager).toBe('function');
    expect(typeof essentials.createLogger).toBe('function');
    expect(typeof essentials.createSessionManager).toBe('function');
    expect(typeof essentials.createMiddlewareChain).toBe('function');
    expect(typeof essentials.createPipeline).toBe('function');
    expect(typeof essentials.HarnessError).toBe('function');
    expect(typeof essentials.MaxIterationsError).toBe('function');
    expect(typeof essentials.AbortedError).toBe('function');
  });

  it('AgentLoop instantiated via essentials runs end-to-end', async () => {
    const adapter = {
      async chat(): Promise<{ message: { role: 'assistant'; content: string }; usage: { inputTokens: number; outputTokens: number } }> {
        return { message: { role: 'assistant', content: 'hi' }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const loop = essentials.createAgentLoop({ adapter });
    let saw = false;
    for await (const ev of loop.run([{ role: 'user', content: 'hello' }])) {
      if (ev.type === 'done') saw = true;
    }
    expect(saw).toBe(true);
  });
});
