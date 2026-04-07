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
});
