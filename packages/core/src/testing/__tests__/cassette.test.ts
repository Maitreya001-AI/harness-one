import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
} from '../../core/types.js';
import {
  createCassetteAdapter,
  recordCassette,
  loadCassette,
  computeKey,
  fingerprint,
} from '../cassette/index.js';

function stubAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'stub',
    async chat(params: ChatParams): Promise<ChatResponse> {
      const last = params.messages[params.messages.length - 1];
      return {
        message: { role: 'assistant', content: `echo:${last?.content ?? ''}` },
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    },
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const last = params.messages[params.messages.length - 1];
      yield { type: 'text_delta', text: `echo:${last?.content ?? ''}` };
      yield { type: 'done', usage: { inputTokens: 3, outputTokens: 4 } };
    },
    ...overrides,
  };
}

describe('cassette record/replay', () => {
  let tmpDir: string;
  let cassettePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cassette-'));
    cassettePath = join(tmpDir, 'test.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records chat() and replay yields identical message + usage', async () => {
    const recorder = recordCassette(stubAdapter(), cassettePath);
    const params: ChatParams = { messages: [{ role: 'user', content: 'hi' }] };
    const original = await recorder.chat(params);

    const replay = createCassetteAdapter(cassettePath);
    const replayed = await replay.chat(params);

    expect(replayed).toEqual(original);
  });

  it('records stream() chunks and replay yields the same sequence', async () => {
    const recorder = recordCassette(stubAdapter(), cassettePath);
    const params: ChatParams = { messages: [{ role: 'user', content: 'stream me' }] };
    const original: StreamChunk[] = [];
    for await (const c of recorder.stream!(params)) original.push(c);

    const replay = createCassetteAdapter(cassettePath);
    const replayed: StreamChunk[] = [];
    for await (const c of replay.stream!(params)) replayed.push(c);

    expect(replayed).toEqual(original);
  });

  it('record then replay produces byte-equal round-trip through the cassette', async () => {
    const recorder = recordCassette(stubAdapter(), cassettePath);
    const params: ChatParams = {
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'bits' },
      ],
      config: { temperature: 0.2, maxTokens: 16 },
    };
    await recorder.chat(params);

    // Write-read-write — second cassette must be byte-equal to the first.
    const first = readFileSync(cassettePath, 'utf8');
    const entries = loadCassette(cassettePath);
    const second = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    expect(second).toEqual(first);
  });

  it('matches by fingerprint — same logical request → same key', () => {
    const a = fingerprint({
      messages: [{ role: 'user', content: 'hi' }],
      config: { temperature: 0.1 },
    });
    const b = fingerprint({
      messages: [{ role: 'user', content: 'hi' }],
      config: { temperature: 0.1, extra: { foo: 'bar' } } as never,
    });
    expect(computeKey('chat', a)).toEqual(computeKey('chat', b));
  });

  it('differentiates chat and stream keys even on identical params', () => {
    const fp = fingerprint({ messages: [{ role: 'user', content: 'x' }] });
    expect(computeKey('chat', fp)).not.toEqual(computeKey('stream', fp));
  });

  it('serves repeated identical calls in record order (FIFO queue)', async () => {
    let count = 0;
    const recorder = recordCassette(
      stubAdapter({
        async chat(): Promise<ChatResponse> {
          count += 1;
          return {
            message: { role: 'assistant', content: `call-${count}` },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
      cassettePath,
    );
    const params: ChatParams = { messages: [{ role: 'user', content: 'repeat' }] };
    await recorder.chat(params);
    await recorder.chat(params);

    const replay = createCassetteAdapter(cassettePath);
    const first = await replay.chat(params);
    const second = await replay.chat(params);
    expect(first.message.content).toBe('call-1');
    expect(second.message.content).toBe('call-2');
  });

  it('throws when a request has no matching cassette entry', async () => {
    const recorder = recordCassette(stubAdapter(), cassettePath);
    await recorder.chat({ messages: [{ role: 'user', content: 'recorded' }] });

    const replay = createCassetteAdapter(cassettePath);
    await expect(
      replay.chat({ messages: [{ role: 'user', content: 'different' }] }),
    ).rejects.toThrow(/No cassette entry matches/);
  });

  it('throws when the cassette queue is exhausted', async () => {
    const recorder = recordCassette(stubAdapter(), cassettePath);
    const params: ChatParams = { messages: [{ role: 'user', content: 'one' }] };
    await recorder.chat(params);

    const replay = createCassetteAdapter(cassettePath);
    await replay.chat(params);
    await expect(replay.chat(params)).rejects.toThrow(/exhausted/);
  });

  it('tolerates malformed final line (simulates interrupted append)', () => {
    // Valid entry followed by a partial write.
    writeFileSync(
      cassettePath,
      JSON.stringify({
        version: 1,
        kind: 'chat',
        key: 'abc',
        request: { messages: [] },
        response: { message: { role: 'assistant', content: 'x' }, usage: { inputTokens: 0, outputTokens: 0 } },
        recordedAtMs: 0,
      }) + '\n{"partial":',
      'utf8',
    );
    const entries = loadCassette(cassettePath);
    expect(entries).toHaveLength(1);
  });

  it('rejects an unsupported schema version', () => {
    writeFileSync(
      cassettePath,
      JSON.stringify({
        version: 9999,
        kind: 'chat',
        key: 'abc',
        request: { messages: [] },
        response: { message: { role: 'assistant', content: 'x' }, usage: { inputTokens: 0, outputTokens: 0 } },
        recordedAtMs: 0,
      }) + '\n',
      'utf8',
    );
    expect(() => loadCassette(cassettePath)).toThrow(/schema/);
  });

  it('replay aborts mid-stream when the signal is already triggered', async () => {
    const recorder = recordCassette(stubAdapter(), cassettePath);
    const params: ChatParams = { messages: [{ role: 'user', content: 'abort' }] };
    for await (const _ of recorder.stream!(params)) { /* drain */ }

    const controller = new AbortController();
    controller.abort();
    const replay = createCassetteAdapter(cassettePath);
    await expect(async () => {
      for await (const _ of replay.stream!({ ...params, signal: controller.signal })) {
        // never reached
      }
    }).rejects.toThrow();
  });

  it('replay aborts when signal fires during simulated timing', async () => {
    // Record a stream with two chunks ~50ms apart (simulated via stubAdapter
    // yielding synchronously, so we hand-craft the cassette instead).
    writeFileSync(
      cassettePath,
      JSON.stringify({
        version: 1,
        kind: 'stream',
        key: computeKey('stream', fingerprint({ messages: [{ role: 'user', content: 'pace' }] })),
        request: fingerprint({ messages: [{ role: 'user', content: 'pace' }] }),
        chunks: [
          { offsetMs: 0, chunk: { type: 'text_delta', text: 'a' } },
          { offsetMs: 100, chunk: { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } } },
        ],
        recordedAtMs: 0,
      }) + '\n',
      'utf8',
    );

    const replay = createCassetteAdapter(cassettePath, { simulateTiming: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(async () => {
      for await (const _ of replay.stream!({
        messages: [{ role: 'user', content: 'pace' }],
        signal: controller.signal,
      })) { /* noop */ }
    }).rejects.toThrow();
  });
});
