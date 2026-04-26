import { describe, it, expect, vi } from 'vitest';
import { createCheckpointManager } from '../checkpoint.js';
import type { CheckpointStorage, Checkpoint } from '../types.js';
import type { Message } from '../../core/types.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';

const msg = (role: string, content: string): Message =>
  ({ role, content }) as unknown as Message;

describe('createCheckpointManager (async since 0.3)', () => {
  const messages: readonly Message[] = [
    msg('user', 'hello'),
    msg('assistant', 'hi there'),
  ];

  it('save() returns a frozen Checkpoint with correct fields', async () => {
    const mgr = createCheckpointManager();
    const cp = await mgr.save(messages, 'first', { key: 'value' });

    expect(cp.id).toEqual(expect.any(String));
    expect(cp.label).toBe('first');
    expect(cp.messages).toEqual(messages);
    expect(cp.tokenCount).toBeGreaterThan(0);
    expect(cp.timestamp).toEqual(expect.any(Number));
    expect(cp.metadata).toEqual({ key: 'value' });
    expect(Object.isFrozen(cp)).toBe(true);
  });

  it('restore() returns a fresh copy of messages', async () => {
    const mgr = createCheckpointManager();
    const cp = await mgr.save(messages);
    const restored = await mgr.restore(cp.id);

    expect(restored).toEqual(messages);
    expect(restored).not.toBe(messages);
    expect(restored).not.toBe(cp.messages);
  });

  it('restore() throws CHECKPOINT_NOT_FOUND for unknown ID', async () => {
    const mgr = createCheckpointManager();
    await expect(mgr.restore('nonexistent')).rejects.toBeInstanceOf(HarnessError);
    await expect(mgr.restore('nonexistent')).rejects.toMatchObject({
      code: HarnessErrorCode.CONTEXT_CHECKPOINT_NOT_FOUND,
    });
  });

  it('auto-prunes oldest when saving beyond maxCheckpoints', async () => {
    const mgr = createCheckpointManager({ maxCheckpoints: 2 });
    const cp1 = await mgr.save(messages, 'first');
    await mgr.save(messages, 'second');
    await mgr.save(messages, 'third');

    const list = await mgr.list();
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('second');
    expect(list[1].label).toBe('third');
    await expect(mgr.restore(cp1.id)).rejects.toBeInstanceOf(HarnessError);
  });

  it('TEST-006: maxCheckpoints: 1 keeps only the most recent checkpoint', async () => {
    const mgr = createCheckpointManager({ maxCheckpoints: 1 });
    const cp1 = await mgr.save(messages, 'first');
    const cp2 = await mgr.save(messages, 'second');

    const list = await mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('second');
    expect(list[0].id).toBe(cp2.id);
    await expect(mgr.restore(cp1.id)).rejects.toBeInstanceOf(HarnessError);
  });

  it('list() returns checkpoints in insertion order', async () => {
    const mgr = createCheckpointManager();
    await mgr.save(messages, 'a');
    await mgr.save(messages, 'b');
    await mgr.save(messages, 'c');

    const labels = (await mgr.list()).map((cp) => cp.label);
    expect(labels).toEqual(['a', 'b', 'c']);
  });

  it('prune() by maxCheckpoints keeps newest', async () => {
    const mgr = createCheckpointManager({ maxCheckpoints: 10 });
    await mgr.save(messages, 'a');
    await mgr.save(messages, 'b');
    await mgr.save(messages, 'c');

    const pruned = await mgr.prune({ maxCheckpoints: 1 });
    expect(pruned).toBe(2);
    const list = await mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('c');
  });

  it('prune() by maxAge removes old checkpoints', async () => {
    const mgr = createCheckpointManager();
    const now = Date.now();

    vi.spyOn(Date, 'now').mockReturnValue(now - 5000);
    await mgr.save(messages, 'old');

    vi.mocked(Date.now).mockReturnValue(now);
    await mgr.save(messages, 'new');

    const pruned = await mgr.prune({ maxAge: 3000 });
    vi.restoreAllMocks();

    expect(pruned).toBe(1);
    const list = await mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('new');
  });

  it('dispose() clears all checkpoints', async () => {
    const mgr = createCheckpointManager();
    await mgr.save(messages, 'a');
    await mgr.save(messages, 'b');
    await mgr.dispose();

    expect(await mgr.list()).toHaveLength(0);
  });

  it('uses custom countTokens when provided', async () => {
    const countTokens = vi.fn(() => 42);
    const mgr = createCheckpointManager({ countTokens });
    const cp = await mgr.save(messages);

    expect(countTokens).toHaveBeenCalledWith(messages);
    expect(cp.tokenCount).toBe(42);
  });

  it('throws INVALID_CONFIG when maxCheckpoints < 1', () => {
    expect(() => createCheckpointManager({ maxCheckpoints: 0 })).toThrow(HarnessError);
    expect(() => createCheckpointManager({ maxCheckpoints: -1 })).toThrow(HarnessError);
    try {
      createCheckpointManager({ maxCheckpoints: 0 });
    } catch (e) {
      expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
    }
  });

  it('generates crypto-backed unique IDs', async () => {
    const mgr = createCheckpointManager();
    const cp1 = await mgr.save(messages, 'a');
    const cp2 = await mgr.save(messages, 'b');
    expect(cp1.id).not.toBe(cp2.id);
    expect(cp1.id).toMatch(/^cp-[a-f0-9]+$/);
    expect(cp2.id).toMatch(/^cp-[a-f0-9]+$/);
  });

  it('uses custom storage backend when provided', async () => {
    const stored = new Map<string, Checkpoint>();
    const storage: CheckpointStorage = {
      save: vi.fn(async (cp) => { stored.set(cp.id, cp); }),
      load: vi.fn(async (id) => stored.get(id)),
      list: vi.fn(async () => [...stored.values()]),
      delete: vi.fn(async (id) => stored.delete(id)),
    };

    const mgr = createCheckpointManager({ storage });
    await mgr.save(messages, 'test');

    expect(storage.save).toHaveBeenCalled();
    expect(await mgr.list()).toHaveLength(1);
    expect(storage.list).toHaveBeenCalled();
  });
});
