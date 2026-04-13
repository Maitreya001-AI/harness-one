import { describe, it, expect, vi } from 'vitest';
import { createCheckpointManager } from '../checkpoint.js';
import type { CheckpointStorage, Checkpoint } from '../types.js';
import type { Message } from '../../core/types.js';
import { HarnessError } from '../../core/errors.js';

const msg = (role: string, content: string): Message =>
  ({ role, content }) as unknown as Message;

describe('createCheckpointManager', () => {
  const messages: readonly Message[] = [
    msg('user', 'hello'),
    msg('assistant', 'hi there'),
  ];

  it('save() returns a frozen Checkpoint with correct fields', () => {
    const mgr = createCheckpointManager();
    const cp = mgr.save(messages, 'first', { key: 'value' });

    expect(cp.id).toEqual(expect.any(String));
    expect(cp.label).toBe('first');
    expect(cp.messages).toEqual(messages);
    expect(cp.tokenCount).toBeGreaterThan(0);
    expect(cp.timestamp).toEqual(expect.any(Number));
    expect(cp.metadata).toEqual({ key: 'value' });
    expect(Object.isFrozen(cp)).toBe(true);
  });

  it('restore() returns a fresh copy of messages', () => {
    const mgr = createCheckpointManager();
    const cp = mgr.save(messages);
    const restored = mgr.restore(cp.id);

    expect(restored).toEqual(messages);
    expect(restored).not.toBe(messages);
    expect(restored).not.toBe(cp.messages);
  });

  it('restore() throws CHECKPOINT_NOT_FOUND for unknown ID', () => {
    const mgr = createCheckpointManager();
    expect(() => mgr.restore('nonexistent')).toThrow(HarnessError);
    try {
      mgr.restore('nonexistent');
    } catch (e) {
      expect((e as HarnessError).code).toBe('CHECKPOINT_NOT_FOUND');
    }
  });

  it('auto-prunes oldest when saving beyond maxCheckpoints', () => {
    const mgr = createCheckpointManager({ maxCheckpoints: 2 });
    const cp1 = mgr.save(messages, 'first');
    mgr.save(messages, 'second');
    mgr.save(messages, 'third');

    const list = mgr.list();
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('second');
    expect(list[1].label).toBe('third');
    expect(() => mgr.restore(cp1.id)).toThrow(HarnessError);
  });

  it('TEST-006: maxCheckpoints: 1 keeps only the most recent checkpoint', () => {
    // Boundary: the smallest legal cap. Saving two checkpoints must leave
    // exactly one entry — the newest.
    const mgr = createCheckpointManager({ maxCheckpoints: 1 });
    const cp1 = mgr.save(messages, 'first');
    const cp2 = mgr.save(messages, 'second');

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('second');
    expect(list[0].id).toBe(cp2.id);
    // First checkpoint was evicted.
    expect(() => mgr.restore(cp1.id)).toThrow(HarnessError);
  });

  it('list() returns checkpoints in insertion order', () => {
    const mgr = createCheckpointManager();
    mgr.save(messages, 'a');
    mgr.save(messages, 'b');
    mgr.save(messages, 'c');

    const labels = mgr.list().map((cp) => cp.label);
    expect(labels).toEqual(['a', 'b', 'c']);
  });

  it('prune() by maxCheckpoints keeps newest', () => {
    const mgr = createCheckpointManager({ maxCheckpoints: 10 });
    mgr.save(messages, 'a');
    mgr.save(messages, 'b');
    mgr.save(messages, 'c');

    const pruned = mgr.prune({ maxCheckpoints: 1 });
    expect(pruned).toBe(2);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0].label).toBe('c');
  });

  it('prune() by maxAge removes old checkpoints', () => {
    const mgr = createCheckpointManager();
    const now = Date.now();

    // Save 'old' with timestamp 5s ago
    vi.spyOn(Date, 'now').mockReturnValue(now - 5000);
    mgr.save(messages, 'old');

    // Save 'new' with current timestamp
    vi.mocked(Date.now).mockReturnValue(now);
    mgr.save(messages, 'new');

    // Prune with maxAge 3000ms — 'old' (5s ago) should be pruned
    const pruned = mgr.prune({ maxAge: 3000 });
    vi.restoreAllMocks();

    expect(pruned).toBe(1);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0].label).toBe('new');
  });

  it('dispose() clears all checkpoints', () => {
    const mgr = createCheckpointManager();
    mgr.save(messages, 'a');
    mgr.save(messages, 'b');
    mgr.dispose();

    expect(mgr.list()).toHaveLength(0);
  });

  it('uses custom countTokens when provided', () => {
    const countTokens = vi.fn(() => 42);
    const mgr = createCheckpointManager({ countTokens });
    const cp = mgr.save(messages);

    expect(countTokens).toHaveBeenCalledWith(messages);
    expect(cp.tokenCount).toBe(42);
  });

  it('throws INVALID_CONFIG when maxCheckpoints < 1', () => {
    expect(() => createCheckpointManager({ maxCheckpoints: 0 })).toThrow(HarnessError);
    expect(() => createCheckpointManager({ maxCheckpoints: -1 })).toThrow(HarnessError);
    try {
      createCheckpointManager({ maxCheckpoints: 0 });
    } catch (e) {
      expect((e as HarnessError).code).toBe('INVALID_CONFIG');
    }
  });

  it('generates IDs with random suffix to avoid collisions', () => {
    const mgr = createCheckpointManager();
    const cp1 = mgr.save(messages, 'a');
    const cp2 = mgr.save(messages, 'b');
    // IDs should be unique
    expect(cp1.id).not.toBe(cp2.id);
    // IDs should contain random suffix (4 chars after last underscore)
    expect(cp1.id).toMatch(/^cp_\d+_\d+_[a-z0-9]{4}$/);
    expect(cp2.id).toMatch(/^cp_\d+_\d+_[a-z0-9]{4}$/);
  });

  it('uses custom storage backend when provided', () => {
    const stored = new Map<string, Checkpoint>();
    const storage: CheckpointStorage = {
      save: vi.fn((cp) => { stored.set(cp.id, cp); }),
      load: vi.fn((id) => stored.get(id)),
      list: vi.fn(() => [...stored.values()]),
      delete: vi.fn((id) => stored.delete(id)),
    };

    const mgr = createCheckpointManager({ storage });
    mgr.save(messages, 'test');

    expect(storage.save).toHaveBeenCalled();
    expect(mgr.list()).toHaveLength(1);
    expect(storage.list).toHaveBeenCalled();
  });
});
