import { describe, it, expect } from 'vitest';
import { createTasteCodingRegistry } from '../taste-coding.js';
import { HarnessError, HarnessErrorCode} from 'harness-one';
import type { TasteCodingRule } from '../types.js';

const makeRule = (overrides: Partial<TasteCodingRule> = {}): TasteCodingRule => ({
  id: 'tc-001',
  pattern: 'Using plain Error',
  rule: 'Use HarnessError instead',
  enforcement: 'lint',
  createdFrom: 'PR #42',
  createdAt: '2025-06-01',
  ...overrides,
});

describe('createTasteCodingRegistry', () => {
  it('adds and retrieves rules', () => {
    const registry = createTasteCodingRegistry();
    registry.addRule(makeRule());
    const rules = registry.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('tc-001');
  });

  it('throws on duplicate rule id', () => {
    const registry = createTasteCodingRegistry();
    registry.addRule(makeRule());
    expect(() => registry.addRule(makeRule())).toThrow(HarnessError);
  });

  it('filters by enforcement type', () => {
    const registry = createTasteCodingRegistry();
    registry.addRule(makeRule({ id: 'r1', enforcement: 'lint' }));
    registry.addRule(makeRule({ id: 'r2', enforcement: 'ci' }));
    registry.addRule(makeRule({ id: 'r3', enforcement: 'manual' }));

    expect(registry.getRules({ enforcement: 'lint' })).toHaveLength(1);
    expect(registry.getRules({ enforcement: 'ci' })).toHaveLength(1);
  });

  it('removes a rule', () => {
    const registry = createTasteCodingRegistry();
    registry.addRule(makeRule());
    registry.removeRule('tc-001');
    expect(registry.count()).toBe(0);
  });

  it('throws when removing unknown rule', () => {
    const registry = createTasteCodingRegistry();
    expect(() => registry.removeRule('nope')).toThrow(HarnessError);
  });

  it('counts rules', () => {
    const registry = createTasteCodingRegistry();
    expect(registry.count()).toBe(0);
    registry.addRule(makeRule({ id: 'r1' }));
    registry.addRule(makeRule({ id: 'r2' }));
    expect(registry.count()).toBe(2);
  });

  describe('exportRules', () => {
    it('exports as markdown', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule());
      const md = registry.exportRules();
      expect(md).toContain('# Taste-Coding Rules');
      expect(md).toContain('tc-001');
      expect(md).toContain('Use HarnessError instead');
      expect(md).toContain('**Enforcement**: lint');
    });

    it('handles empty registry', () => {
      const registry = createTasteCodingRegistry();
      const md = registry.exportRules();
      expect(md).toContain('No rules defined');
    });
  });

  describe('checkCompliance (H2: enforcement mechanism)', () => {
    it('detects violations matching lint-level rules', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-001',
        pattern: 'new Error',
        rule: 'Use HarnessError instead of plain Error',
        enforcement: 'lint',
      }));

      const violations = registry.checkCompliance('throw new Error("something broke")');
      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe('tc-001');
      expect(violations[0].rule).toBe('Use HarnessError instead of plain Error');
    });

    it('detects violations matching ci-level rules', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-002',
        pattern: 'console.log',
        rule: 'Use structured logging',
        enforcement: 'ci',
      }));

      const violations = registry.checkCompliance('console.log("debug info")');
      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe('tc-002');
    });

    it('skips manual-enforcement rules', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-003',
        pattern: 'TODO',
        rule: 'Resolve TODOs before merge',
        enforcement: 'manual',
      }));

      const violations = registry.checkCompliance('// TODO: fix this later');
      expect(violations).toHaveLength(0);
    });

    it('returns empty array for compliant code', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-001',
        pattern: 'new Error',
        rule: 'Use HarnessError',
        enforcement: 'lint',
      }));

      const violations = registry.checkCompliance('throw new HarnessError("proper error")');
      expect(violations).toHaveLength(0);
    });

    it('detects multiple violations from different rules', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-001',
        pattern: 'new Error',
        rule: 'Use HarnessError',
        enforcement: 'lint',
      }));
      registry.addRule(makeRule({
        id: 'tc-002',
        pattern: 'console.log',
        rule: 'Use structured logging',
        enforcement: 'ci',
      }));

      const code = 'throw new Error("bad"); console.log("also bad");';
      const violations = registry.checkCompliance(code);
      expect(violations).toHaveLength(2);
    });
  });

  describe('getMetrics (H2: enforcement metrics)', () => {
    it('returns total rules count', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({ id: 'r1' }));
      registry.addRule(makeRule({ id: 'r2', enforcement: 'ci' }));
      registry.addRule(makeRule({ id: 'r3', enforcement: 'manual' }));

      const metrics = registry.getMetrics();
      expect(metrics.totalRules).toBe(3);
    });

    it('returns rules grouped by enforcement level', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({ id: 'r1', enforcement: 'lint' }));
      registry.addRule(makeRule({ id: 'r2', enforcement: 'lint' }));
      registry.addRule(makeRule({ id: 'r3', enforcement: 'ci' }));
      registry.addRule(makeRule({ id: 'r4', enforcement: 'manual' }));

      const metrics = registry.getMetrics();
      expect(metrics.byEnforcement.lint).toBe(2);
      expect(metrics.byEnforcement.ci).toBe(1);
      expect(metrics.byEnforcement.manual).toBe(1);
    });

    it('returns zero counts for empty registry', () => {
      const registry = createTasteCodingRegistry();
      const metrics = registry.getMetrics();
      expect(metrics.totalRules).toBe(0);
      expect(metrics.byEnforcement.lint).toBe(0);
      expect(metrics.byEnforcement.ci).toBe(0);
      expect(metrics.byEnforcement.manual).toBe(0);
    });

    it('returns lastCheckTimestamp (null initially, updated after checkCompliance)', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({ id: 'r1', enforcement: 'lint' }));

      expect(registry.getMetrics().lastCheckTimestamp).toBeNull();

      registry.checkCompliance('some code');
      expect(registry.getMetrics().lastCheckTimestamp).not.toBeNull();
      expect(typeof registry.getMetrics().lastCheckTimestamp).toBe('number');
    });
  });

  describe('word-boundary matching (false positive reduction)', () => {
    it('does not match pattern as substring of larger word', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-error',
        pattern: 'Error',
        rule: 'Use HarnessError',
        enforcement: 'lint',
      }));

      // "ErrorHandler" contains "Error" as substring but is a different word
      const violations = registry.checkCompliance('class ErrorHandler extends Base {}');
      expect(violations).toHaveLength(0);
    });

    it('matches pattern when it appears as standalone word', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-error',
        pattern: 'Error',
        rule: 'Use HarnessError',
        enforcement: 'lint',
      }));

      const violations = registry.checkCompliance('throw new Error("something broke")');
      expect(violations).toHaveLength(1);
    });

    it('does not false-positive on pattern embedded in identifier', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-log',
        pattern: 'log',
        rule: 'Use structured logging',
        enforcement: 'lint',
      }));

      // "blog" contains "log" as substring
      const violations = registry.checkCompliance('const blog = createBlog();');
      expect(violations).toHaveLength(0);
    });

    it('matches word-boundary pattern correctly in multi-word code', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-log',
        pattern: 'log',
        rule: 'Use structured logging',
        enforcement: 'lint',
      }));

      const violations = registry.checkCompliance('console.log("debug")');
      expect(violations).toHaveLength(1);
    });

    it('escapes regex special characters in patterns', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-eval',
        pattern: 'eval(',
        rule: 'Never use eval',
        enforcement: 'lint',
      }));

      // The pattern "eval(" has a regex special char "(" — it should be escaped
      const violations = registry.checkCompliance('eval(code)');
      expect(violations).toHaveLength(1);
    });

    it('does not match escaped regex chars as wildcards', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-dot',
        pattern: 'a.b',
        rule: 'Do not use a.b',
        enforcement: 'lint',
      }));

      // "." in the pattern should be literal, not regex wildcard
      // "axb" should NOT match "a.b"
      const violations = registry.checkCompliance('const x = axb;');
      expect(violations).toHaveLength(0);
    });
  });

  // Fix 12: Regex safety
  describe('regex safety (Fix 12)', () => {
    it('rejects patterns exceeding max length', () => {
      const registry = createTasteCodingRegistry();
      const longPattern = 'a'.repeat(501);
      expect(() => registry.addRule(makeRule({
        id: 'long-pattern',
        pattern: longPattern,
        enforcement: 'lint',
      }))).toThrow(HarnessError);

      try {
        registry.addRule(makeRule({
          id: 'long-pattern',
          pattern: longPattern,
          enforcement: 'lint',
        }));
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_PATTERN);
      }
    });

    it('accepts patterns at max length', () => {
      const registry = createTasteCodingRegistry();
      const maxPattern = 'a'.repeat(500);
      expect(() => registry.addRule(makeRule({
        id: 'max-pattern',
        pattern: maxPattern,
        enforcement: 'lint',
      }))).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('checkCompliance with compliant code — empty violations', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-001',
        pattern: 'eval(',
        rule: 'Never use eval',
        enforcement: 'lint',
      }));
      registry.addRule(makeRule({
        id: 'tc-002',
        pattern: 'var ',
        rule: 'Use const/let instead of var',
        enforcement: 'ci',
      }));

      const violations = registry.checkCompliance('const x = 42; const y = x + 1;');
      expect(violations).toHaveLength(0);
    });

    it('getMetrics tracks lastCheckTimestamp updates', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({ id: 'r1', enforcement: 'lint' }));

      expect(registry.getMetrics().lastCheckTimestamp).toBeNull();

      registry.checkCompliance('some code');
      const firstTimestamp = registry.getMetrics().lastCheckTimestamp;
      expect(firstTimestamp).not.toBeNull();
      expect(typeof firstTimestamp).toBe('number');

      // Second check should update the timestamp
      registry.checkCompliance('more code');
      const secondTimestamp = registry.getMetrics().lastCheckTimestamp;
      expect(secondTimestamp).not.toBeNull();
      expect(secondTimestamp!).toBeGreaterThanOrEqual(firstTimestamp!);
    });

    it('manual enforcement rules skipped in checkCompliance', () => {
      const registry = createTasteCodingRegistry();
      registry.addRule(makeRule({
        id: 'tc-manual',
        pattern: 'TODO',
        rule: 'Resolve TODOs before merge',
        enforcement: 'manual',
      }));
      registry.addRule(makeRule({
        id: 'tc-lint',
        pattern: 'console.log',
        rule: 'Use structured logging',
        enforcement: 'lint',
      }));

      // Code has both patterns, but only the lint rule should trigger
      const violations = registry.checkCompliance('// TODO: console.log("debug")');
      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe('tc-lint');
      // Manual rule should NOT appear in violations
      expect(violations.some(v => v.ruleId === 'tc-manual')).toBe(false);
    });
  });
});
