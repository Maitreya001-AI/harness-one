import { describe, it, expect } from 'vitest';
import {
  HarnessError,
  MaxIterationsError,
  AbortedError,
  ToolValidationError,
  TokenBudgetExceededError,
  HarnessErrorCode,
  createCustomErrorCode,
} from '../errors.js';

describe('HarnessError', () => {
  it('sets message, code, and suggestion', () => {
    const err = new HarnessError('test', 'TEST', 'try again');
    expect(err.message).toBe('test');
    expect(err.code).toBe('TEST');
    expect(err.suggestion).toBe('try again');
    expect(err.name).toBe('HarnessError');
    expect(err).toBeInstanceOf(Error);
  });

  it('captures cause', () => {
    const cause = new Error('root');
    const err = new HarnessError('wrapped', 'WRAP', undefined, cause);
    expect(err.cause).toBe(cause);
  });

  it('works without suggestion', () => {
    const err = new HarnessError('msg', 'CODE');
    expect(err.suggestion).toBeUndefined();
  });
});

describe('MaxIterationsError', () => {
  it('has correct code and iterations', () => {
    const err = new MaxIterationsError(25);
    expect(err.code).toBe(HarnessErrorCode.CORE_MAX_ITERATIONS);
    expect(err.iterations).toBe(25);
    expect(err.name).toBe('MaxIterationsError');
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.message).toContain('25');
  });
});

describe('AbortedError', () => {
  it('has correct code', () => {
    const err = new AbortedError();
    expect(err.code).toBe(HarnessErrorCode.CORE_ABORTED);
    expect(err.name).toBe('AbortedError');
    expect(err).toBeInstanceOf(HarnessError);
  });
});

describe('guardrail-block error (HarnessError form)', () => {
  it('carries GUARD_BLOCKED / GUARD_VIOLATION codes from the pipeline', () => {
    /* The GuardrailBlockedError subclass has been removed. The pipeline
     * throws plain HarnessError with the typed code instead. This test
     * locks in the guard-code contract for consumers. */
    const blocked = new HarnessError(
      'Guardrail blocked: toxic content',
      HarnessErrorCode.GUARD_BLOCKED,
      'Review the guardrail configuration and input',
    );
    expect(blocked.code).toBe(HarnessErrorCode.GUARD_BLOCKED);
    expect(blocked.message).toContain('toxic content');
    expect(blocked).toBeInstanceOf(HarnessError);

    const violation = new HarnessError(
      'Guardrail violation detected',
      HarnessErrorCode.GUARD_VIOLATION,
    );
    expect(violation.code).toBe(HarnessErrorCode.GUARD_VIOLATION);
  });
});

describe('ToolValidationError', () => {
  it('has correct code', () => {
    const err = new ToolValidationError('bad params');
    expect(err.code).toBe(HarnessErrorCode.TOOL_VALIDATION);
    expect(err.message).toBe('bad params');
    expect(err).toBeInstanceOf(HarnessError);
  });
});

describe('TokenBudgetExceededError', () => {
  it('has correct code, used, and budget', () => {
    const err = new TokenBudgetExceededError(50000, 100000);
    expect(err.code).toBe(HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED);
    expect(err.used).toBe(50000);
    expect(err.budget).toBe(100000);
    expect(err.message).toContain('50000');
    expect(err.message).toContain('100000');
    expect(err).toBeInstanceOf(HarnessError);
  });
});

describe('typed error codes', () => {
  it('accepts ADAPTER_INVALID_EXTRA as a typed code', () => {
    const err = new HarnessError(
      'unknown extra key "foo"',
      HarnessErrorCode.ADAPTER_INVALID_EXTRA,
      'Remove the key or disable strict mode',
    );
    expect(err.code).toBe(HarnessErrorCode.ADAPTER_INVALID_EXTRA);
    expect(err).toBeInstanceOf(HarnessError);
  });

  it('accepts TOOL_CAPABILITY_DENIED as a typed code', () => {
    const err = new HarnessError(
      'tool capability "network" not in registry allow-list',
      HarnessErrorCode.TOOL_CAPABILITY_DENIED,
    );
    expect(err.code).toBe(HarnessErrorCode.TOOL_CAPABILITY_DENIED);
    expect(err).toBeInstanceOf(HarnessError);
  });

  it('accepts PROVIDER_REGISTRY_SEALED as a typed code', () => {
    const err = new HarnessError(
      'provider registry is sealed; cannot register "openai"',
      HarnessErrorCode.PROVIDER_REGISTRY_SEALED,
      'Register providers before sealing the registry',
    );
    expect(err.code).toBe(HarnessErrorCode.PROVIDER_REGISTRY_SEALED);
    expect(err).toBeInstanceOf(HarnessError);
  });
});

describe('createCustomErrorCode extension point', () => {
  // The closed HarnessErrorCode enum can't be extended by downstream packages
  // without forking. `createCustomErrorCode` is the canonical escape hatch:
  // downstream packages (@harness-one/prompt, adapter SDKs, etc.) thread a
  // Readonly<HarnessErrorDetails> bag through `HarnessError` while the code
  // itself stays `ADAPTER_CUSTOM` so switch-exhaustiveness checks keep working.
  // These tests lock the contract in place so the helper cannot rot silently.

  it('returns a frozen { namespace, customCode } details bag', () => {
    const details = createCustomErrorCode('prompt', 'TEMPLATE_NOT_FOUND');
    expect(details).toEqual({ namespace: 'prompt', customCode: 'TEMPLATE_NOT_FOUND' });
    expect(Object.isFrozen(details)).toBe(true);
  });

  it('wraps into HarnessError with ADAPTER_CUSTOM code + preserved namespace bag', () => {
    const details = createCustomErrorCode('@harness-one/redis', 'CONNECTION_LOST');
    const err = new HarnessError(
      'redis connection dropped mid-transaction',
      HarnessErrorCode.ADAPTER_CUSTOM,
      'Reconnect and retry',
      undefined,
      details,
    );
    expect(err.code).toBe(HarnessErrorCode.ADAPTER_CUSTOM);
    expect(err.details).toEqual({
      namespace: '@harness-one/redis',
      customCode: 'CONNECTION_LOST',
    });
    // The underlying enum member stays unchanged so a consumer can keep its
    // switch-on-code exhaustiveness check without adding new cases per package.
    switch (err.code) {
      case HarnessErrorCode.ADAPTER_CUSTOM:
        expect(err.details?.customCode).toBe('CONNECTION_LOST');
        break;
      default:
        throw new Error('unreachable — custom errors must land on ADAPTER_CUSTOM');
    }
  });

  it('rejects empty namespace', () => {
    expect(() => createCustomErrorCode('', 'X')).toThrow(HarnessError);
    try {
      createCustomErrorCode('', 'X');
    } catch (err) {
      expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_INPUT);
    }
  });

  it('rejects empty code', () => {
    expect(() => createCustomErrorCode('ns', '')).toThrow(HarnessError);
    try {
      createCustomErrorCode('ns', '');
    } catch (err) {
      expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_INPUT);
    }
  });

  it('rejects non-string inputs (runtime-only invariant)', () => {
    // Runtime callers from JS can pass anything; the helper must refuse.
    expect(() =>
      createCustomErrorCode(undefined as unknown as string, 'X'),
    ).toThrow(HarnessError);
    expect(() =>
      createCustomErrorCode('ns', 123 as unknown as string),
    ).toThrow(HarnessError);
  });
});
