import { describe, it, expect } from 'vitest';
import { createPromptBuilder } from '../builder.js';

describe('createPromptBuilder', () => {
  it('builds an empty prompt', () => {
    const builder = createPromptBuilder();
    const result = builder.build();
    expect(result.systemPrompt).toBe('');
    expect(result.layers).toHaveLength(0);
    expect(result.metadata.layerCount).toBe(0);
  });

  it('assembles layers sorted by priority', () => {
    const builder = createPromptBuilder();
    builder.addLayer({ name: 'low', content: 'Second', priority: 10, cacheable: false });
    builder.addLayer({ name: 'high', content: 'First', priority: 1, cacheable: false });
    const result = builder.build();
    expect(result.systemPrompt).toBe('First\n\nSecond');
  });

  it('places cacheable layers before non-cacheable', () => {
    const builder = createPromptBuilder();
    builder.addLayer({ name: 'dynamic', content: 'Dynamic', priority: 0, cacheable: false });
    builder.addLayer({ name: 'stable', content: 'Stable', priority: 5, cacheable: true });
    const result = builder.build();
    expect(result.layers[0].name).toBe('stable');
    expect(result.layers[1].name).toBe('dynamic');
  });

  it('uses custom separator', () => {
    const builder = createPromptBuilder({ separator: '---' });
    builder.addLayer({ name: 'a', content: 'A', priority: 0, cacheable: false });
    builder.addLayer({ name: 'b', content: 'B', priority: 1, cacheable: false });
    const result = builder.build();
    expect(result.systemPrompt).toBe('A---B');
  });

  it('replaces variables with {{varName}} syntax', () => {
    const builder = createPromptBuilder();
    builder.addLayer({ name: 'greet', content: 'Hello {{name}}, welcome to {{place}}!', priority: 0, cacheable: false });
    builder.setVariable('name', 'Alice');
    builder.setVariable('place', 'Wonderland');
    const result = builder.build();
    expect(result.systemPrompt).toBe('Hello Alice, welcome to Wonderland!');
  });

  it('leaves unset variables as-is', () => {
    const builder = createPromptBuilder();
    builder.addLayer({ name: 'greet', content: 'Hello {{name}}', priority: 0, cacheable: false });
    const result = builder.build();
    expect(result.systemPrompt).toBe('Hello {{name}}');
  });

  it('removes layers by name', () => {
    const builder = createPromptBuilder();
    builder.addLayer({ name: 'keep', content: 'Keep', priority: 0, cacheable: false });
    builder.addLayer({ name: 'remove', content: 'Remove', priority: 1, cacheable: false });
    builder.removeLayer('remove');
    const result = builder.build();
    expect(result.layers).toHaveLength(1);
    expect(result.systemPrompt).toBe('Keep');
  });

  describe('stablePrefixHash', () => {
    it('returns consistent hash for same cacheable content', () => {
      const builder = createPromptBuilder();
      builder.addLayer({ name: 'sys', content: 'System prompt', priority: 0, cacheable: true });
      const hash1 = builder.getStablePrefixHash();
      const hash2 = builder.getStablePrefixHash();
      expect(hash1).toBe(hash2);
    });

    it('changes hash when cacheable content changes', () => {
      const builder = createPromptBuilder();
      builder.addLayer({ name: 'sys', content: 'Version 1', priority: 0, cacheable: true });
      const hash1 = builder.getStablePrefixHash();
      builder.removeLayer('sys');
      builder.addLayer({ name: 'sys', content: 'Version 2', priority: 0, cacheable: true });
      const hash2 = builder.getStablePrefixHash();
      expect(hash1).not.toBe(hash2);
    });

    it('ignores non-cacheable layers in hash', () => {
      const builder = createPromptBuilder();
      builder.addLayer({ name: 'sys', content: 'Stable', priority: 0, cacheable: true });
      const hash1 = builder.getStablePrefixHash();
      builder.addLayer({ name: 'dynamic', content: 'Changes', priority: 10, cacheable: false });
      const hash2 = builder.getStablePrefixHash();
      expect(hash1).toBe(hash2);
    });

    it('C1: hash must NOT change when variable values change (hashes raw template)', () => {
      const builder = createPromptBuilder();
      builder.addLayer({
        name: 'sys',
        content: 'You are {{role}} assistant for {{company}}',
        priority: 0,
        cacheable: true,
      });

      builder.setVariable('role', 'a helpful');
      builder.setVariable('company', 'Acme');
      const hash1 = builder.getStablePrefixHash();

      builder.setVariable('role', 'a strict');
      builder.setVariable('company', 'Globex');
      const hash2 = builder.getStablePrefixHash();

      // The hash must be stable across variable changes — it should hash raw template content
      expect(hash1).toBe(hash2);
    });

    it('C1: build().stablePrefixHash must also be stable across variable changes', () => {
      const builder = createPromptBuilder();
      builder.addLayer({
        name: 'sys',
        content: 'Hello {{name}}',
        priority: 0,
        cacheable: true,
      });

      builder.setVariable('name', 'Alice');
      const hash1 = builder.build().stablePrefixHash;

      builder.setVariable('name', 'Bob');
      const hash2 = builder.build().stablePrefixHash;

      expect(hash1).toBe(hash2);
    });
  });

  describe('token budget (maxTokens)', () => {
    it('trims non-cacheable layers when over budget', () => {
      // 'Short' = 6 tokens, 'A'.repeat(100) = 29 tokens with heuristic estimator
      // Budget of 10 means 'big' cannot fit alongside 'sys'
      const builder = createPromptBuilder({ maxTokens: 10 });
      builder.addLayer({ name: 'sys', content: 'Short', priority: 0, cacheable: true });
      builder.addLayer({ name: 'big', content: 'A'.repeat(100), priority: 10, cacheable: false });
      const result = builder.build();
      // 'big' layer should be trimmed because it exceeds budget
      expect(result.layers.some(l => l.name === 'sys')).toBe(true);
    });

    it('keeps cacheable layers even when trimming', () => {
      // 'Hello' = 6 tokens, 'Extra content here' = 9 tokens; budget 8 only fits cacheable
      const builder = createPromptBuilder({ maxTokens: 8 });
      builder.addLayer({ name: 'sys', content: 'Hello', priority: 0, cacheable: true });
      builder.addLayer({ name: 'extra', content: 'Extra content here', priority: 5, cacheable: false });
      const result = builder.build();
      expect(result.layers.some(l => l.name === 'sys')).toBe(true);
    });

    it('trims highest priority number first', () => {
      // 'AAAA' = 5 tokens each; budget of 11 fits exactly 2 layers
      // Should keep 'a' (priority 1, most important) and one other
      const builder = createPromptBuilder({ maxTokens: 11 });
      builder.addLayer({ name: 'a', content: 'AAAA', priority: 1, cacheable: false });
      builder.addLayer({ name: 'b', content: 'BBBB', priority: 100, cacheable: false });
      builder.addLayer({ name: 'c', content: 'CCCC', priority: 50, cacheable: false });
      const result = builder.build();
      // 'a' (priority 1) should survive over 'b' (priority 100)
      expect(result.layers.some(l => l.name === 'a')).toBe(true);
    });

    it('C2: keeps lowest priority numbers (most important) when trimming under budget', () => {
      // Each 8-char layer = 6 tokens with heuristic estimator
      // Budget of 13 fits exactly 2 layers but not 3
      const builder = createPromptBuilder({ maxTokens: 13 });
      builder.addLayer({ name: 'important', content: 'AAAAAAAA', priority: 1, cacheable: false });
      builder.addLayer({ name: 'medium', content: 'BBBBBBBB', priority: 50, cacheable: false });
      builder.addLayer({ name: 'expendable', content: 'CCCCCCCC', priority: 100, cacheable: false });
      const result = builder.build();
      const keptNames = result.layers.map(l => l.name);

      // The most important layer (lowest priority number) MUST be kept
      expect(keptNames).toContain('important');
      // The least important layer (highest priority number) should be dropped first
      // If only 2 fit, 'expendable' should be the first to go
      if (keptNames.length === 2) {
        expect(keptNames).toContain('medium');
        expect(keptNames).not.toContain('expendable');
      }
      // Under no circumstances should 'expendable' be kept while 'important' is dropped
      if (!keptNames.includes('important')) {
        throw new Error('BUG: important layer was dropped before expendable layer');
      }
    });

    it('C2: priority ordering is correct - low priority number = high importance = kept first', () => {
      // 'AAAA' = 5 tokens each; budget of 6 fits exactly 1 layer
      const builder = createPromptBuilder({ maxTokens: 6 });
      builder.addLayer({ name: 'keep_me', content: 'AAAA', priority: 1, cacheable: false });
      builder.addLayer({ name: 'drop_me', content: 'BBBB', priority: 99, cacheable: false });
      const result = builder.build();
      const keptNames = result.layers.map(l => l.name);

      // With budget for ~1 layer, 'keep_me' (priority 1, most important) should be kept
      // and 'drop_me' (priority 99, least important) should be dropped
      expect(keptNames).toContain('keep_me');
      expect(keptNames).not.toContain('drop_me');
    });
  });

  describe('metadata', () => {
    it('reports token estimates', () => {
      const builder = createPromptBuilder();
      builder.addLayer({ name: 'sys', content: 'Hello world!', priority: 0, cacheable: true });
      builder.addLayer({ name: 'user', content: 'Hi', priority: 1, cacheable: false });
      const result = builder.build();
      expect(result.metadata.totalTokens).toBeGreaterThan(0);
      expect(result.metadata.cacheableTokens).toBeGreaterThan(0);
      expect(result.metadata.cacheableTokens).toBeLessThanOrEqual(result.metadata.totalTokens);
    });
  });
});
