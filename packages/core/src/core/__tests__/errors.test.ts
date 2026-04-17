import { describe, it, expect } from 'vitest';
import {
  HarnessError,
  MaxIterationsError,
  AbortedError,
  ToolValidationError,
  TokenBudgetExceededError, HarnessErrorCode} from '../errors.js';

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
    /* Wave-17 removed the GuardrailBlockedError subclass. The pipeline
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

describe('Wave-5 error codes', () => {
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
