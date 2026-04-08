import { describe, it, expect } from 'vitest';
import { createDisclosureManager } from '../disclosure.js';
import { HarnessError } from '../../core/errors.js';

describe('createDisclosureManager', () => {
  const authLevels = [
    { level: 0, content: 'Auth uses JWT.' },
    { level: 1, content: 'Tokens expire after 1h.' },
    { level: 2, content: 'Refresh via httpOnly cookies.' },
  ];

  it('registers a topic and starts at level 0', () => {
    const dm = createDisclosureManager();
    dm.register('auth', authLevels);
    expect(dm.getCurrentLevel('auth')).toBe(0);
  });

  it('throws for unknown topic', () => {
    const dm = createDisclosureManager();
    expect(() => dm.getContent('nope')).toThrow(HarnessError);
  });

  describe('getContent', () => {
    it('returns level 0 content by default', () => {
      const dm = createDisclosureManager();
      dm.register('auth', authLevels);
      expect(dm.getContent('auth')).toBe('Auth uses JWT.');
    });

    it('returns content up to specified maxLevel', () => {
      const dm = createDisclosureManager();
      dm.register('auth', authLevels);
      const content = dm.getContent('auth', 1);
      expect(content).toBe('Auth uses JWT.\nTokens expire after 1h.');
    });

    it('returns all content at max level', () => {
      const dm = createDisclosureManager();
      dm.register('auth', authLevels);
      const content = dm.getContent('auth', 2);
      expect(content).toContain('Auth uses JWT.');
      expect(content).toContain('Refresh via httpOnly cookies.');
    });
  });

  describe('expand', () => {
    it('advances to next level and returns its content', () => {
      const dm = createDisclosureManager();
      dm.register('auth', authLevels);
      const content = dm.expand('auth');
      expect(content).toBe('Tokens expire after 1h.');
      expect(dm.getCurrentLevel('auth')).toBe(1);
    });

    it('expands through multiple levels', () => {
      const dm = createDisclosureManager();
      dm.register('auth', authLevels);
      dm.expand('auth'); // -> 1
      const content = dm.expand('auth'); // -> 2
      expect(content).toBe('Refresh via httpOnly cookies.');
      expect(dm.getCurrentLevel('auth')).toBe(2);
    });

    it('returns last level content when fully expanded', () => {
      const dm = createDisclosureManager();
      dm.register('auth', authLevels);
      dm.expand('auth'); // -> 1
      dm.expand('auth'); // -> 2
      const content = dm.expand('auth'); // already at max
      expect(dm.getCurrentLevel('auth')).toBe(2);
      expect(content).toBeDefined();
    });
  });

  describe('reset', () => {
    it('resets topic to level 0', () => {
      const dm = createDisclosureManager();
      dm.register('auth', authLevels);
      dm.expand('auth');
      dm.expand('auth');
      dm.reset('auth');
      expect(dm.getCurrentLevel('auth')).toBe(0);
    });
  });

  describe('listTopics', () => {
    it('lists registered topics', () => {
      const dm = createDisclosureManager();
      dm.register('auth', authLevels);
      dm.register('db', [{ level: 0, content: 'Uses Postgres' }]);
      expect(dm.listTopics()).toEqual(['auth', 'db']);
    });
  });

  it('handles unsorted levels on register', () => {
    const dm = createDisclosureManager();
    dm.register('test', [
      { level: 2, content: 'Deep' },
      { level: 0, content: 'Basic' },
      { level: 1, content: 'More' },
    ]);
    expect(dm.getContent('test')).toBe('Basic');
    expect(dm.getContent('test', 2)).toBe('Basic\nMore\nDeep');
  });

  describe('edge cases', () => {
    it('expand beyond max level — stays at max', () => {
      const dm = createDisclosureManager();
      dm.register('small', [
        { level: 0, content: 'Level 0' },
        { level: 1, content: 'Level 1' },
      ]);
      dm.expand('small'); // -> 1
      dm.expand('small'); // attempt -> 2, stays at 1
      dm.expand('small'); // attempt -> 3, stays at 1
      expect(dm.getCurrentLevel('small')).toBe(1);
    });

    it('register topic with single level', () => {
      const dm = createDisclosureManager();
      dm.register('single', [{ level: 0, content: 'Only level' }]);
      expect(dm.getContent('single')).toBe('Only level');
      expect(dm.getCurrentLevel('single')).toBe(0);
      // Expanding should stay at level 0 since there is no level 1
      const expandResult = dm.expand('single');
      expect(dm.getCurrentLevel('single')).toBe(0);
      // Should return the content for the current (max) level
      expect(expandResult).toBeDefined();
    });

    it('getContent with maxLevel=0 — returns only level 0 content', () => {
      const dm = createDisclosureManager();
      dm.register('auth', [
        { level: 0, content: 'Auth uses JWT.' },
        { level: 1, content: 'Tokens expire after 1h.' },
        { level: 2, content: 'Refresh via httpOnly cookies.' },
      ]);
      // Even after expanding, getContent with maxLevel=0 should return only level 0
      dm.expand('auth');
      dm.expand('auth');
      const content = dm.getContent('auth', 0);
      expect(content).toBe('Auth uses JWT.');
      expect(content).not.toContain('Tokens expire');
      expect(content).not.toContain('Refresh');
    });
  });
});
