import { describe, expect, it } from 'vitest';

import { installSignalHandlers } from '../../src/cli/signals.js';

describe('installSignalHandlers', () => {
  it('aborts the AbortController on first SIGINT and force-exits on second', () => {
    const aborter = new AbortController();
    const exits: number[] = [];
    const logs: string[] = [];

    const { cleanup } = installSignalHandlers({
      aborter,
      exit: (code) => exits.push(code),
      log: (m) => logs.push(m),
    });

    process.emit('SIGINT');
    expect(aborter.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
    expect(logs.some((m) => m.includes('aborting'))).toBe(true);

    process.emit('SIGINT');
    expect(exits).toEqual([130]);
    expect(logs.some((m) => m.includes('force-exiting'))).toBe(true);

    cleanup();
  });

  it('handles SIGTERM the same way as SIGINT', () => {
    const aborter = new AbortController();
    const exits: number[] = [];
    const { cleanup } = installSignalHandlers({
      aborter,
      exit: (code) => exits.push(code),
      log: () => undefined,
    });
    process.emit('SIGTERM');
    expect(aborter.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
    cleanup();
  });

  it('cleanup removes the listeners from process', () => {
    const aborter = new AbortController();
    const before = process.listenerCount('SIGINT');
    const { cleanup } = installSignalHandlers({
      aborter,
      exit: () => undefined,
      log: () => undefined,
    });
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(before);
    cleanup();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
