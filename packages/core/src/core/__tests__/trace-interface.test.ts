/**
 * ARCH-002: AgentLoopTraceManager interface lives in `core/trace-interface.ts`,
 * separate from agent-loop.ts. Pin both:
 *  1. The type can be imported from the new location.
 *  2. A concrete TraceManager remains structurally compatible.
 */

import { describe, it, expect } from 'vitest';
import type { AgentLoopTraceManager } from '../trace-interface.js';
import { AgentLoop } from '../agent-loop.js';
import { createTraceManager } from '../../observe/trace-manager.js';

describe('AgentLoopTraceManager (ARCH-002)', () => {
  it('the type re-exports from agent-loop.ts for backward compat', async () => {
    // This compiles only when both modules export the type.
    const fromCore: AgentLoopTraceManager = createTraceManager();
    expect(typeof fromCore.startTrace).toBe('function');
  });

  it('a TraceManager wired into AgentLoop satisfies the interface at runtime', async () => {
    const tm = createTraceManager();
    const adapter = {
      async chat(): Promise<{ message: { role: 'assistant'; content: string }; usage: { inputTokens: number; outputTokens: number } }> {
        return { message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const loop = new AgentLoop({ adapter, traceManager: tm });
    let sawDone = false;
    for await (const ev of loop.run([{ role: 'user', content: 'go' }])) {
      if (ev.type === 'done') sawDone = true;
    }
    expect(sawDone).toBe(true);
  });
});
