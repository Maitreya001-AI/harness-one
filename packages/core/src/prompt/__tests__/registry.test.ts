import { describe, it, expect } from 'vitest';
import { createPromptRegistry } from '../registry.js';
import { HarnessError } from '../../core/errors.js';

describe('createPromptRegistry', () => {
  it('registers and retrieves a template', () => {
    const reg = createPromptRegistry();
    reg.register({ id: 'greet', version: '1.0', content: 'Hello {{name}}', variables: ['name'] });
    const t = reg.get('greet');
    expect(t).toBeDefined();
    expect(t!.id).toBe('greet');
  });

  it('returns undefined for unknown template', () => {
    const reg = createPromptRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('supports multiple versions', () => {
    const reg = createPromptRegistry();
    reg.register({ id: 'greet', version: '1.0', content: 'Hello v1', variables: [] });
    reg.register({ id: 'greet', version: '2.0', content: 'Hello v2', variables: [] });
    expect(reg.get('greet', '1.0')!.content).toBe('Hello v1');
    expect(reg.get('greet', '2.0')!.content).toBe('Hello v2');
  });

  it('returns latest version by default', () => {
    const reg = createPromptRegistry();
    reg.register({ id: 'greet', version: '1.0', content: 'Hello v1', variables: [] });
    reg.register({ id: 'greet', version: '2.0', content: 'Hello v2', variables: [] });
    expect(reg.get('greet')!.content).toBe('Hello v2');
  });

  it('freezes templates on register', () => {
    const reg = createPromptRegistry();
    const template = { id: 'a', version: '1.0', content: 'test', variables: [] };
    reg.register(template);
    const stored = reg.get('a')!;
    expect(Object.isFrozen(stored)).toBe(true);
  });

  describe('resolve', () => {
    it('replaces variables in content', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'greet', version: '1.0', content: 'Hello {{name}}, age {{age}}', variables: ['name', 'age'] });
      const result = reg.resolve('greet', { name: 'Alice', age: '30' });
      expect(result).toBe('Hello Alice, age 30');
    });

    it('resolves a specific version', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'g', version: '1.0', content: 'V1 {{x}}', variables: ['x'] });
      reg.register({ id: 'g', version: '2.0', content: 'V2 {{x}}', variables: ['x'] });
      expect(reg.resolve('g', { x: 'val' }, '1.0')).toBe('V1 val');
    });

    it('throws HarnessError for missing template', () => {
      const reg = createPromptRegistry();
      expect(() => reg.resolve('nope', {})).toThrow(HarnessError);
      try {
        reg.resolve('nope', {});
      } catch (e) {
        expect((e as HarnessError).code).toBe('TEMPLATE_NOT_FOUND');
      }
    });

    it('throws HarnessError for missing variable', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'g', version: '1.0', content: 'Hello {{name}}', variables: ['name'] });
      expect(() => reg.resolve('g', {})).toThrow(HarnessError);
      try {
        reg.resolve('g', {});
      } catch (e) {
        expect((e as HarnessError).code).toBe('MISSING_VARIABLE');
      }
    });
  });

  describe('list', () => {
    it('lists all templates across versions', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'a', version: '1.0', content: 'A', variables: [] });
      reg.register({ id: 'b', version: '1.0', content: 'B', variables: [] });
      expect(reg.list()).toHaveLength(2);
    });
  });

  describe('has', () => {
    it('returns true for registered templates', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'a', version: '1.0', content: 'A', variables: [] });
      expect(reg.has('a')).toBe(true);
      expect(reg.has('b')).toBe(false);
    });
  });
});
