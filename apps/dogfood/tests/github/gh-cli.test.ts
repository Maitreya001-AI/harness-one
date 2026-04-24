import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

type SpawnArgs = readonly [string, readonly string[], { stdio: readonly string[] }];

interface FakeChild extends EventEmitter {
  stdin: { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

let createGhRunner: typeof import('../../src/github/gh-cli.js').createGhRunner;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import('../../src/github/gh-cli.js');
  createGhRunner = mod.createGhRunner;
});

describe('createGhRunner — dryRun', () => {
  it('short-circuits without spawning when dryRun is true', async () => {
    const runner = createGhRunner({ dryRun: true });
    const result = await runner.run(['issue', 'list', '--repo', 'a/b']);
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('still invokes onCommand in dryRun so callers can assert on the recorded shape', async () => {
    const onCommand = vi.fn();
    const runner = createGhRunner({ dryRun: true, onCommand });
    await runner.run(['issue', 'comment', '1']);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(['issue', 'comment', '1']);
  });

  it('is usable with no options at all (both dryRun and onCommand default-absent)', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);

    const runner = createGhRunner();
    const promise = runner.run(['auth', 'status']);

    child.stdout.emit('data', Buffer.from('ok\n'));
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({ stdout: 'ok\n', stderr: '', exitCode: 0 });
  });
});

describe('createGhRunner — live spawn path', () => {
  it('invokes gh via spawn with piped stdio and concatenates stdout/stderr chunks', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);

    const runner = createGhRunner();
    const promise = runner.run(['issue', 'list', '--limit', '5']);

    // Verify argv + stdio shape *before* resolving so we catch the literal
    // spawn('gh', ...) contract with stdin/stdout/stderr all piped.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const call = mockSpawn.mock.calls[0] as unknown as SpawnArgs;
    expect(call[0]).toBe('gh');
    expect(call[1]).toEqual(['issue', 'list', '--limit', '5']);
    expect(call[2]).toEqual({ stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.emit('data', Buffer.from('chunk-1 '));
    child.stdout.emit('data', Buffer.from('chunk-2'));
    child.stderr.emit('data', Buffer.from('warn: foo'));
    child.emit('close', 0);

    const result = await promise;
    expect(result).toEqual({ stdout: 'chunk-1 chunk-2', stderr: 'warn: foo', exitCode: 0 });
    // stdin.end() is always called — with the provided body or with nothing.
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.stdin.end).toHaveBeenCalledWith();
  });

  it('pipes the provided stdin body through child.stdin.end', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);

    const runner = createGhRunner();
    const promise = runner.run(['issue', 'comment', '1', '-F', '-'], { stdin: 'body text' });

    child.emit('close', 0);
    await promise;

    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.stdin.end).toHaveBeenCalledWith('body text');
  });

  it('propagates a non-zero exit code through to the caller', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);

    const runner = createGhRunner();
    const promise = runner.run(['issue', 'edit', '1']);

    child.stderr.emit('data', Buffer.from('label not found'));
    child.emit('close', 2);

    await expect(promise).resolves.toEqual({
      stdout: '',
      stderr: 'label not found',
      exitCode: 2,
    });
  });

  it('defaults exitCode to 0 when close fires with null (child killed by signal with no code)', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);

    const runner = createGhRunner();
    const promise = runner.run(['auth', 'status']);

    child.emit('close', null);

    await expect(promise).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('rejects the run promise when the child emits error (e.g. gh not on PATH)', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child);

    const runner = createGhRunner();
    const promise = runner.run(['auth', 'status']);

    child.emit('error', new Error('ENOENT: gh not found'));

    await expect(promise).rejects.toThrow(/ENOENT: gh not found/);
  });
});
