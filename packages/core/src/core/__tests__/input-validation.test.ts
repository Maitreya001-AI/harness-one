/**
 * Input validation tests for production audit hardening.
 *
 * Verifies that constructors and factory functions reject invalid configs
 * with HarnessError (code HarnessErrorCode.CORE_INVALID_CONFIG).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import { HarnessError, HarnessErrorCode} from '../errors.js';
import type { AgentAdapter, ChatResponse } from '../types.js';
import { compress } from '../../context/compress.js';
import { createSessionManager } from '../../session/manager.js';
import { createTraceManager } from '../../observe/trace-manager.js';
import { createMessageQueue } from '../../orchestration/message-queue.js';
import { withSelfHealing } from '../../guardrails/self-healing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock adapter for AgentLoop construction (never called). */
function mockAdapter(): AgentAdapter {
  return {
    async chat(): Promise<ChatResponse> {
      return {
        message: { role: 'assistant', content: 'ok' },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

function expectInvalidConfig(fn: () => unknown, messagePart?: string): void {
  try {
    fn();
    expect.fail('Expected HarnessError with code INVALID_CONFIG to be thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
    if (messagePart) {
      expect((err as HarnessError).message).toContain(messagePart);
    }
  }
}

async function expectInvalidConfigAsync(fn: () => Promise<unknown>, messagePart?: string): Promise<void> {
  try {
    await fn();
    expect.fail('Expected HarnessError with code INVALID_CONFIG to be thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
    if (messagePart) {
      expect((err as HarnessError).message).toContain(messagePart);
    }
  }
}

// ---------------------------------------------------------------------------
// AgentLoop constructor validation
// ---------------------------------------------------------------------------

describe('AgentLoop input validation', () => {
  describe('maxIterations', () => {
    it('throws INVALID_CONFIG when maxIterations is 0', () => {
      expectInvalidConfig(
        () => new AgentLoop({ adapter: mockAdapter(), maxIterations: 0 }),
        'maxIterations must be >= 1',
      );
    });

    it('throws INVALID_CONFIG when maxIterations is -1', () => {
      expectInvalidConfig(
        () => new AgentLoop({ adapter: mockAdapter(), maxIterations: -1 }),
        'maxIterations must be >= 1',
      );
    });
  });

  describe('maxTotalTokens', () => {
    it('throws INVALID_CONFIG when maxTotalTokens is 0', () => {
      expectInvalidConfig(
        () => new AgentLoop({ adapter: mockAdapter(), maxTotalTokens: 0 }),
        'maxTotalTokens must be > 0',
      );
    });

    it('throws INVALID_CONFIG when maxTotalTokens is -1', () => {
      expectInvalidConfig(
        () => new AgentLoop({ adapter: mockAdapter(), maxTotalTokens: -1 }),
        'maxTotalTokens must be > 0',
      );
    });
  });

  describe('maxStreamBytes', () => {
    it('throws INVALID_CONFIG when maxStreamBytes is 0', () => {
      expectInvalidConfig(
        () => new AgentLoop({ adapter: mockAdapter(), maxStreamBytes: 0 }),
        'maxStreamBytes must be > 0',
      );
    });
  });

  describe('maxToolArgBytes', () => {
    it('throws INVALID_CONFIG when maxToolArgBytes is 0', () => {
      expectInvalidConfig(
        () => new AgentLoop({ adapter: mockAdapter(), maxToolArgBytes: 0 }),
        'maxToolArgBytes must be > 0',
      );
    });
  });

  describe('toolTimeoutMs', () => {
    it('throws INVALID_CONFIG when toolTimeoutMs is 0', () => {
      expectInvalidConfig(
        () => new AgentLoop({ adapter: mockAdapter(), toolTimeoutMs: 0 }),
        'toolTimeoutMs must be > 0',
      );
    });

    it('throws INVALID_CONFIG when toolTimeoutMs is -1', () => {
      expectInvalidConfig(
        () => new AgentLoop({ adapter: mockAdapter(), toolTimeoutMs: -1 }),
        'toolTimeoutMs must be > 0',
      );
    });
  });

  describe('valid configs (should NOT throw)', () => {
    it('accepts defaults (no explicit values)', () => {
      expect(() => new AgentLoop({ adapter: mockAdapter() })).not.toThrow();
    });

    it('accepts explicit positive maxIterations', () => {
      expect(() => new AgentLoop({ adapter: mockAdapter(), maxIterations: 1 })).not.toThrow();
      expect(() => new AgentLoop({ adapter: mockAdapter(), maxIterations: 100 })).not.toThrow();
    });

    it('accepts explicit positive maxTotalTokens', () => {
      expect(() => new AgentLoop({ adapter: mockAdapter(), maxTotalTokens: 1 })).not.toThrow();
      expect(() => new AgentLoop({ adapter: mockAdapter(), maxTotalTokens: 1_000_000 })).not.toThrow();
    });

    it('accepts explicit positive maxStreamBytes', () => {
      expect(() => new AgentLoop({ adapter: mockAdapter(), maxStreamBytes: 1 })).not.toThrow();
    });

    it('accepts explicit positive maxToolArgBytes', () => {
      expect(() => new AgentLoop({ adapter: mockAdapter(), maxToolArgBytes: 1 })).not.toThrow();
    });

    it('accepts explicit positive toolTimeoutMs', () => {
      expect(() => new AgentLoop({ adapter: mockAdapter(), toolTimeoutMs: 1 })).not.toThrow();
    });

    it('accepts undefined toolTimeoutMs (optional)', () => {
      expect(() => new AgentLoop({ adapter: mockAdapter(), toolTimeoutMs: undefined })).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// compress() validation
// ---------------------------------------------------------------------------

describe('compress() input validation', () => {
  const messages = [{ role: 'user' as const, content: 'hello world' }];

  it('throws INVALID_CONFIG when budget is 0', async () => {
    await expectInvalidConfigAsync(
      () => compress(messages, { strategy: 'truncate', budget: 0 }),
      'budget must be > 0',
    );
  });

  it('throws INVALID_CONFIG when budget is -1', async () => {
    await expectInvalidConfigAsync(
      () => compress(messages, { strategy: 'truncate', budget: -1 }),
      'budget must be > 0',
    );
  });

  it('accepts positive budget', async () => {
    const result = await compress(messages, { strategy: 'truncate', budget: 100 });
    expect(result.messages).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SessionManager validation
// ---------------------------------------------------------------------------

describe('SessionManager input validation', () => {
  // Session managers set up GC timers so we must dispose them to prevent leaks.
  const managers: Array<{ dispose: () => void }> = [];

  afterEach(() => {
    for (const m of managers) {
      try { m.dispose(); } catch { /* ignore */ }
    }
    managers.length = 0;
  });

  it('throws INVALID_CONFIG when maxSessions is 0', () => {
    expectInvalidConfig(
      () => createSessionManager({ maxSessions: 0 }),
      'maxSessions must be >= 1',
    );
  });

  it('throws INVALID_CONFIG when ttlMs is 0', () => {
    expectInvalidConfig(
      () => createSessionManager({ ttlMs: 0 }),
      'ttlMs must be > 0',
    );
  });

  it('throws INVALID_CONFIG when ttlMs is -1', () => {
    expectInvalidConfig(
      () => createSessionManager({ ttlMs: -1 }),
      'ttlMs must be > 0',
    );
  });

  it('accepts valid config with positive values', () => {
    const sm = createSessionManager({ maxSessions: 5, ttlMs: 1000 });
    managers.push(sm);
    expect(sm.maxSessions).toBe(5);
  });

  it('accepts default config', () => {
    const sm = createSessionManager();
    managers.push(sm);
    expect(sm.maxSessions).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// TraceManager validation
// ---------------------------------------------------------------------------

describe('TraceManager input validation', () => {
  it('throws INVALID_CONFIG when maxTraces is 0', () => {
    // Wave-16 m3: message now routes through the shared `requirePositiveInt`
    // helper in core/infra/validate.ts.
    expectInvalidConfig(
      () => createTraceManager({ maxTraces: 0 }),
      'maxTraces must be a positive integer',
    );
  });

  it('accepts positive maxTraces', () => {
    const tm = createTraceManager({ maxTraces: 5 });
    expect(tm).toBeDefined();
  });

  it('accepts default config', () => {
    const tm = createTraceManager();
    expect(tm).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MessageQueue validation
// ---------------------------------------------------------------------------

describe('MessageQueue input validation', () => {
  it('throws INVALID_CONFIG when maxQueueSize is 0', () => {
    expectInvalidConfig(
      () => createMessageQueue({ maxQueueSize: 0 }),
      'maxQueueSize must be >= 1',
    );
  });

  it('accepts positive maxQueueSize', () => {
    const mq = createMessageQueue({ maxQueueSize: 10 });
    expect(mq).toBeDefined();
  });

  it('accepts default config', () => {
    const mq = createMessageQueue();
    expect(mq).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// withSelfHealing validation
// ---------------------------------------------------------------------------

describe('withSelfHealing input validation', () => {
  const baseConfig = {
    guardrails: [{ name: 'test', guard: () => ({ action: 'allow' as const }) }],
    buildRetryPrompt: () => 'retry',
    regenerate: async () => 'regenerated',
  };

  it('throws INVALID_CONFIG when maxRetries is 0', async () => {
    await expectInvalidConfigAsync(
      () => withSelfHealing({ ...baseConfig, maxRetries: 0 }, 'content'),
      'maxRetries must be >= 1',
    );
  });

  it('accepts positive maxRetries', async () => {
    const result = await withSelfHealing({ ...baseConfig, maxRetries: 1 }, 'content');
    expect(result.passed).toBe(true);
  });

  it('accepts default maxRetries', async () => {
    const result = await withSelfHealing({ ...baseConfig }, 'content');
    expect(result.passed).toBe(true);
  });
});
