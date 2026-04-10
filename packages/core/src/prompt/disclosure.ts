/**
 * Progressive disclosure — load knowledge/instructions level by level.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';

/** A single disclosure level for a topic. */
export interface DisclosureLevel {
  readonly level: number;
  readonly content: string;
  readonly trigger?: string;
}

/** Manager for progressive disclosure of topic content. */
export interface DisclosureManager {
  /** Register disclosure levels for a topic. */
  register(topic: string, levels: DisclosureLevel[]): void;
  /** Get content up to a maximum level for a topic. */
  getContent(topic: string, maxLevel?: number): string;
  /** Expand to the next level and return its content. */
  expand(topic: string): string;
  /** Get the current disclosure level for a topic. */
  getCurrentLevel(topic: string): number;
  /** Reset a topic back to level 0. */
  reset(topic: string): void;
  /** List all registered topics. */
  listTopics(): string[];
}

/**
 * Create a new DisclosureManager instance.
 *
 * @example
 * ```ts
 * const dm = createDisclosureManager();
 * dm.register('auth', [
 *   { level: 0, content: 'Auth uses JWT tokens.' },
 *   { level: 1, content: 'Tokens expire after 1 hour.' },
 *   { level: 2, content: 'Refresh tokens are stored in httpOnly cookies.' },
 * ]);
 * dm.getContent('auth');       // Level 0 content
 * dm.expand('auth');           // Returns level 1 content
 * dm.getContent('auth', 1);   // Levels 0 + 1 combined
 * ```
 */
export function createDisclosureManager(): DisclosureManager {
  const topics = new Map<string, DisclosureLevel[]>();
  const currentLevels = new Map<string, number>();

  function requireTopic(topic: string): DisclosureLevel[] {
    const levels = topics.get(topic);
    if (!levels) {
      throw new HarnessError(
        `Topic not found: ${topic}`,
        'TOPIC_NOT_FOUND',
        'Register the topic before accessing it',
      );
    }
    return levels;
  }

  function getContentFn(topic: string, maxLevel?: number): string {
    const levels = requireTopic(topic);
    const max = maxLevel ?? currentLevels.get(topic) ?? 0;
    return levels
      .filter(l => l.level <= max)
      .map(l => l.content)
      .join('\n');
  }

  return {
    register(topic: string, levels: DisclosureLevel[]): void {
      const sorted = [...levels].sort((a, b) => a.level - b.level);
      topics.set(topic, sorted);
      currentLevels.set(topic, 0);
    },

    getContent: getContentFn,

    expand(topic: string): string {
      const levels = requireTopic(topic);
      const current = currentLevels.get(topic) ?? 0;
      const maxAvailable = levels[levels.length - 1].level;

      // Find the next available level entry above the current level, skipping gaps
      const nextEntry = levels.find(l => l.level > current);

      if (!nextEntry || current >= maxAvailable) {
        return getContentFn(topic, current);
      }

      currentLevels.set(topic, nextEntry.level);
      return nextEntry.content;
    },

    getCurrentLevel(topic: string): number {
      requireTopic(topic);
      return currentLevels.get(topic) ?? 0;
    },

    reset(topic: string): void {
      requireTopic(topic);
      currentLevels.set(topic, 0);
    },

    listTopics(): string[] {
      return Array.from(topics.keys());
    },
  };
}
