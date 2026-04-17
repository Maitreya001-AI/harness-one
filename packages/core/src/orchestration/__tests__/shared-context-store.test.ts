/**
 * Unit tests for the extracted SharedContext factory. Pins the behaviour
 * that was previously inline in orchestrator.ts so refactors on either
 * side cannot drift.
 */

import { describe, it, expect } from 'vitest';
import {
  createSharedContext,
  normalizeContextKey,
  FORBIDDEN_CONTEXT_KEYS,
} from '../shared-context-store.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';
import type { OrchestratorEvent } from '../types.js';

function makeStore(maxEntries = 100) {
  const events: OrchestratorEvent[] = [];
  const emit = (e: OrchestratorEvent): void => {
    events.push(e);
  };
  return { store: createSharedContext({ maxEntries, emit }), events };
}

describe('createSharedContext', () => {
  it('rejects empty string keys', () => {
    const { store } = makeStore();
    expect(() => store.context.set('', 1)).toThrow(HarnessError);
  });

  it('rejects polluting keys (direct and Unicode variants)', () => {
    const { store } = makeStore();
    for (const k of FORBIDDEN_CONTEXT_KEYS) {
      expect(() => store.context.set(k, 1)).toThrow(HarnessError);
    }
    // Unicode width variant of __proto__ would normalize to __proto__
    expect(normalizeContextKey('__PROTO__')).toBe('__proto__');
  });

  it('round-trips set/get through case-folded normalization', () => {
    const { store } = makeStore();
    store.context.set('Foo.Bar', 42);
    expect(store.context.get('foo.bar')).toBe(42);
    expect(store.context.get<number>('FOO.BAR')).toBe(42);
  });

  it('emits context_updated with the normalized key', () => {
    const { store, events } = makeStore();
    store.context.set('Admin.Tools', 'on');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'context_updated', key: 'admin.tools' });
  });

  it('enforces maxEntries on new insertions only', () => {
    const { store } = makeStore(2);
    store.context.set('a', 1);
    store.context.set('b', 2);
    // Overwrite is fine.
    store.context.set('a', 3);
    expect(store.context.get('a')).toBe(3);
    // Third key breaches the cap.
    expect(() => store.context.set('c', 4)).toThrow(
      /cap of 2 entries/,
    );
  });

  it('uses ORCH_CONTEXT_LIMIT for cap breaches', () => {
    const { store } = makeStore(1);
    store.context.set('a', 1);
    try {
      store.context.set('b', 2);
    } catch (err) {
      expect((err as HarnessError).code).toBe(HarnessErrorCode.ORCH_CONTEXT_LIMIT);
    }
  });

  it('deleteByPrefix removes the whole namespace', () => {
    const { store } = makeStore();
    store.context.set('user:1:name', 'alice');
    store.context.set('user:1:age', 30);
    store.context.set('user:2:name', 'bob');
    expect(store.context.deleteByPrefix('user:1:')).toBe(2);
    expect(store.context.get('user:1:name')).toBeUndefined();
    expect(store.context.get('user:2:name')).toBe('bob');
  });

  it('clear() returns the previous size', () => {
    const { store } = makeStore();
    store.context.set('a', 1);
    store.context.set('b', 2);
    expect(store.context.clear()).toBe(2);
    expect(store.context.entries().size).toBe(0);
  });

  it('dispose() clears the store silently (no events)', () => {
    const { store, events } = makeStore();
    store.context.set('a', 1);
    const before = events.length;
    store.dispose();
    expect(store.context.entries().size).toBe(0);
    expect(events.length).toBe(before);
  });
});
