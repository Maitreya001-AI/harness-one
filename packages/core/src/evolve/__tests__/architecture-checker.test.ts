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

  describe('weak module detection fix', () => {
    it('does NOT match /mycore/ as module "core" (path segment matching)', () => {
      const rule = layerDependencyRule({
        core: [],
        context: ['core'],
      });
      // src/mycore/utils.ts should NOT be recognized as belonging to module "core"
      const result = rule.check({
        files: ['src/mycore/utils.ts'],
        imports: {
          'src/mycore/utils.ts': ['src/context/pack.ts'],
        },
      });
      // If getModule matches 'mycore' as 'core', it would detect a violation
      // (core importing from context). Since 'mycore' is NOT 'core', no violation.
      expect(result.passed).toBe(true);
    });

    it('does NOT match /scorecard/ as module "core"', () => {
      const rule = layerDependencyRule({
        core: [],
        context: ['core'],
      });
      const result = rule.check({
        files: ['src/scorecard/report.ts'],
        imports: {
          'src/scorecard/report.ts': ['src/context/pack.ts'],
        },
      });
      expect(result.passed).toBe(true);
    });

    it('still correctly matches exact /core/ path segment', () => {
      const rule = layerDependencyRule({
        core: [],
        context: ['core'],
      });
      const result = rule.check({
        files: ['src/core/types.ts'],
        imports: {
          'src/core/types.ts': ['src/context/pack.ts'],
        },
      });
      // core importing from context IS a violation
      expect(result.passed).toBe(false);
    });
  });
});

describe('noCircularDepsRule - weak module detection fix', () => {
  it('does NOT match /mycore/ as module "core"', () => {
    const rule = noCircularDepsRule(['core', 'context']);
    const result = rule.check({
      files: ['src/mycore/utils.ts', 'src/context/pack.ts'],
      imports: {
        'src/mycore/utils.ts': ['src/context/pack.ts'],
        'src/context/pack.ts': ['src/mycore/utils.ts'],
      },
    });
    // mycore should not be matched as core, so no cycle between core and context
    expect(result.passed).toBe(true);
  });
});

// Fix 13: Performance cache
describe('architecture-checker cache (Fix 13)', () => {
  it('returns cached result for same context', () => {
    const checker = createArchitectureChecker();
    let checkCount = 0;
    checker.addRule({
      id: 'counting-rule',
      name: 'Counter',
      description: 'Counts checks',
      check: () => {
        checkCount++;
        return { passed: true, violations: [] };
      },
    });

    const context = { files: ['a.ts'], imports: {} };
    checker.check(context);
    expect(checkCount).toBe(1);

    // Same context should use cache
    checker.check(context);
    expect(checkCount).toBe(1);
  });

  it('invalidates cache when rules are added', () => {
    const checker = createArchitectureChecker();
    let checkCount = 0;
    checker.addRule({
      id: 'rule-1',
      name: 'Rule 1',
      description: 'First rule',
      check: () => {
        checkCount++;
        return { passed: true, violations: [] };
      },
    });

    const context = { files: ['a.ts'], imports: {} };
    checker.check(context);
    expect(checkCount).toBe(1);

    // Add another rule - cache should be invalidated
    checker.addRule({
      id: 'rule-2',
      name: 'Rule 2',
      description: 'Second rule',
      check: () => {
        checkCount++;
        return { passed: true, violations: [] };
      },
    });

    checker.check(context);
    expect(checkCount).toBe(3); // Both rules checked
  });
});

// Fix 14: Specific suggestions
describe('noCircularDepsRule specific suggestions (Fix 14)', () => {
  it('includes specific modules in violation suggestion', () => {
    const rule = noCircularDepsRule(['core', 'context']);
    const result = rule.check({
      files: ['src/core/types.ts', 'src/context/pack.ts'],
      imports: {
        'src/core/types.ts': ['src/context/pack.ts'],
        'src/context/pack.ts': ['src/core/types.ts'],
      },
    });
    expect(result.passed).toBe(false);
    // Suggestion should mention specific modules
    const violation = result.violations[0];
    expect(violation.suggestion).toContain('core');
    expect(violation.suggestion).toContain('context');
    expect(violation.message).toContain('Circular dependency detected');
  });
});

describe('architecture-checker edge cases', () => {
  it('path segment matching does not false-positive on substrings', () => {
    const rule = layerDependencyRule({
      core: [],
      context: ['core'],
    });
    // 'hardcore' contains 'core' but should not be matched
    const result = rule.check({
      files: ['src/hardcore/utils.ts'],
      imports: {
        'src/hardcore/utils.ts': ['src/context/pack.ts'],
      },
    });
    // 'hardcore' is NOT module 'core', so no violation
    expect(result.passed).toBe(true);

    // But 'core' as a proper path segment DOES match
    const result2 = rule.check({
      files: ['src/core/types.ts'],
      imports: {
        'src/core/types.ts': ['src/context/pack.ts'],
      },
    });
    expect(result2.passed).toBe(false);
  });

  it('self-import cycle detection', () => {
    const rule = noCircularDepsRule(['core', 'context']);
    // A file in 'core' importing from another file in 'core' should not trigger cycle
    const result = rule.check({
      files: ['src/core/types.ts', 'src/core/errors.ts'],
      imports: {
        'src/core/types.ts': ['src/core/errors.ts'],
        'src/core/errors.ts': ['src/core/types.ts'],
      },
    });
    // Same module imports are not cross-module cycles
    expect(result.passed).toBe(true);
  });

  it('empty dependency map', () => {
    const checker = createArchitectureChecker();
    checker.addRule(noCircularDepsRule(['core', 'context', 'tools']));
    checker.addRule(layerDependencyRule({
      core: [],
      context: ['core'],
      tools: ['core'],
    }));
    const result = checker.check({ files: [], imports: {} });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
