import { describe, it, expect } from 'vitest';
import {
  createArchitectureChecker,
  noCircularDepsRule,
  layerDependencyRule,
} from '../architecture-checker.js';

describe('createArchitectureChecker', () => {
  it('passes when no rules', () => {
    const checker = createArchitectureChecker();
    const result = checker.check({ files: [], imports: {} });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('runs added rules', () => {
    const checker = createArchitectureChecker();
    checker.addRule({
      id: 'test-rule',
      name: 'Test',
      description: 'Always fails',
      check: () => ({
        passed: false,
        violations: [{ file: 'a.ts', message: 'bad', suggestion: 'fix it' }],
      }),
    });
    const result = checker.check({ files: ['a.ts'], imports: {} });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it('lists rules', () => {
    const checker = createArchitectureChecker();
    checker.addRule({
      id: 'r1',
      name: 'Rule 1',
      description: 'desc',
      check: () => ({ passed: true, violations: [] }),
    });
    expect(checker.listRules()).toHaveLength(1);
  });
});

describe('noCircularDepsRule', () => {
  it('passes when no cycles', () => {
    const rule = noCircularDepsRule(['core', 'context', 'tools']);
    const result = rule.check({
      files: ['src/context/pack.ts', 'src/tools/runner.ts'],
      imports: {
        'src/context/pack.ts': ['src/core/types.ts'],
        'src/tools/runner.ts': ['src/core/types.ts'],
      },
    });
    expect(result.passed).toBe(true);
  });

  it('detects circular dependency', () => {
    const rule = noCircularDepsRule(['core', 'context']);
    const result = rule.check({
      files: ['src/core/types.ts', 'src/context/pack.ts'],
      imports: {
        'src/core/types.ts': ['src/context/pack.ts'],
        'src/context/pack.ts': ['src/core/types.ts'],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

describe('layerDependencyRule', () => {
  it('passes when imports follow layer rules', () => {
    const rule = layerDependencyRule({
      core: [],
      context: ['core'],
      tools: ['core'],
    });
    const result = rule.check({
      files: ['src/context/pack.ts'],
      imports: {
        'src/context/pack.ts': ['src/core/types.ts'],
      },
    });
    expect(result.passed).toBe(true);
  });

  it('fails when importing from disallowed layer', () => {
    const rule = layerDependencyRule({
      core: [],
      context: ['core'],
      tools: ['core'],
    });
    const result = rule.check({
      files: ['src/core/types.ts'],
      imports: {
        'src/core/types.ts': ['src/context/pack.ts'],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('allows same-module imports', () => {
    const rule = layerDependencyRule({
      core: [],
      context: ['core'],
    });
    const result = rule.check({
      files: ['src/core/types.ts'],
      imports: {
        'src/core/types.ts': ['src/core/errors.ts'],
      },
    });
    expect(result.passed).toBe(true);
  });
});
