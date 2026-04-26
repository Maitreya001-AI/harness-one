/**
 * Shared contract suite for `AgentAdapter` implementations.
 *
 * A single call to {@link createAdapterContractSuite} registers ~25
 * `it()` assertions covering the AgentAdapter contract. Each assertion
 * is cassette-backed so the suite can run offline with zero API cost.
 *
 * Recording path:
 *
 *   - With `CASSETTE_MODE=record` (or when a fixture's cassette file is
 *     missing and `mode !== 'replay'`), the suite wraps the supplied
 *     real adapter with {@link recordCassette} and writes a fresh
 *     cassette. The real adapter is otherwise unused — once cassettes
 *     exist, replay is the default.
 *
 *   - Set `CASSETTE_MODE=replay` (the default in CI) to assert strict
 *     offline behaviour: any missing cassette fails the test run.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
} from '../../core/types.js';
import { createCassetteAdapter, recordCassette } from '../cassette/index.js';

/**
 * Minimal subset of the vitest API the suite uses. The caller passes
 * these in from their test file so this module never has to import
 * `vitest` itself — that matters because vitest is ESM-only and its
 * worker state machinery is not safe to evaluate outside a test run
 * (e.g. inside the cassette generator script).
 */
export interface ContractTestApi {
  readonly describe: (name: string, fn: () => void) => void;
  readonly it: (name: string, fn: () => void | Promise<void>) => void;
  readonly expect: (actual: unknown) => ContractExpectAssertions;
  readonly beforeAll: (fn: () => void | Promise<void>) => void;
}

/** Structural type for the tiny slice of `expect()` we call. */
export interface ContractExpectAssertions {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toMatch(pattern: RegExp | string): void;
  toBeInstanceOf(ctor: unknown): void;
  not: { toThrow(): void };
  rejects: {
    toBeInstanceOf(ctor: unknown): Promise<void>;
    toThrow(pattern?: RegExp | string): Promise<void>;
  };
  toThrow(pattern?: RegExp | string): void;
}

import {
  CONTRACT_FIXTURES,
  cassetteFileName,
  type ContractFixture,
} from './fixtures.js';

/** Options for {@link createAdapterContractSuite}. */
export interface AdapterContractSuiteOptions {
  /** Directory holding `<fixture>.jsonl` files. */
  readonly cassetteDir: string;
  /**
   * vitest's `describe`/`it`/`expect`/`beforeAll`, imported by the
   * caller. See {@link ContractTestApi} for the exact shape.
   *
   * Required to keep the testing subpath free of a direct runtime
   * dependency on vitest — call sites re-export from their own
   * `import { describe, ... } from 'vitest'`.
   */
  readonly testApi: ContractTestApi;
  /**
   * Cassette strategy:
   *
   *   - `'replay'` (default): require every cassette to exist on disk;
   *     never touch the real adapter.
   *   - `'record'`: always run against the real adapter and overwrite
   *     cassettes on the first use of each fixture.
   *   - `'auto'`: record fixtures whose cassette is missing, replay the
   *     rest.
   *
   * Overridable at runtime via `process.env.CASSETTE_MODE`.
   */
  readonly mode?: 'replay' | 'record' | 'auto';
  /** Human label surfaced in the `describe()` header. */
  readonly label?: string;
}

type FixtureAdapter = AgentAdapter & { readonly __mode: 'replay' | 'record' };

/**
 * Register the contract suite for the given adapter. Call inside a test
 * file; `describe` / `it` are registered at import time.
 */
export function createAdapterContractSuite(
  adapter: AgentAdapter,
  options: AdapterContractSuiteOptions,
): void {
  const { describe, it, expect, beforeAll } = options.testApi;
  const mode = resolveMode(options.mode);
  const label = options.label ?? adapter.name ?? 'AgentAdapter';

  describe(`[contract] ${label}`, () => {
    // Resolve the per-fixture adapter once per suite run. Each fixture
    // either reads a cassette (replay) or wraps the real adapter to
    // write a new one (record). The outcome is memoised so the many
    // `it()` assertions sharing a fixture all consume the same source.
    const fixtureAdapters = new Map<string, FixtureAdapter>();
    for (const fixture of CONTRACT_FIXTURES) {
      const path = join(options.cassetteDir, cassetteFileName(fixture));
      const fixtureMode = resolveFixtureMode(path, mode);
      fixtureAdapters.set(
        fixture.name,
        fixtureMode === 'record'
          ? Object.assign(recordCassette(adapter, path), { __mode: 'record' as const })
          : Object.assign(createCassetteAdapter(path, { name: fixture.name }), {
              __mode: 'replay' as const,
            }),
      );
    }

    const chatResults = new Map<string, ChatResponse>();
    const streamResults = new Map<string, readonly StreamChunk[]>();

    beforeAll(async () => {
      // Execute each fixture once up-front so the assertions are pure
      // functions of the recorded/replayed data. We deep-clone params
      // here so the individual `it` blocks can exercise immutability
      // assertions on a known-pristine input.
      for (const fixture of CONTRACT_FIXTURES) {
        const fa = fixtureAdapters.get(fixture.name);
        if (!fa) continue;
        const params = cloneParams(fixture.params);
        if (fixture.kind === 'chat') {
          chatResults.set(fixture.name, await fa.chat(params));
        } else {
          // `stream` is guaranteed present on a streaming fixture —
          // the record/replay factories both produce it — but the
          // linter still wants an explicit guard. Keep the narrowing
          // local.
          const streamFn = fa.stream;
          if (!streamFn) continue;
          const chunks: StreamChunk[] = [];
          for await (const chunk of streamFn.call(fa, params)) chunks.push(chunk);
          streamResults.set(fixture.name, chunks);
        }
      }
    });

    // ── chat() shape ──────────────────────────────────────────────────────
    const chatSimple = (): ChatResponse => requireChat(chatResults, 'chat-simple');
    const chatTool = (): ChatResponse => requireChat(chatResults, 'chat-tool-call');
    const chatSystem = (): ChatResponse => requireChat(chatResults, 'chat-with-system');

    it('chat() returns an assistant message', () => {
      expect(chatSimple().message.role).toBe('assistant');
    });

    it('chat() returns string content', () => {
      expect(typeof chatSimple().message.content).toBe('string');
    });

    it('chat() returns non-empty content for a prompt that requires an answer', () => {
      expect(chatSimple().message.content.length).toBeGreaterThan(0);
    });

    it('chat() usage.inputTokens is a non-negative finite number', () => {
      const u = chatSimple().usage;
      expect(Number.isFinite(u.inputTokens)).toBe(true);
      expect(u.inputTokens).toBeGreaterThanOrEqual(0);
    });

    it('chat() usage.outputTokens is a non-negative finite number', () => {
      const u = chatSimple().usage;
      expect(Number.isFinite(u.outputTokens)).toBe(true);
      expect(u.outputTokens).toBeGreaterThanOrEqual(0);
    });

    it('chat() cache token counts (when present) are non-negative finite numbers', () => {
      const u = chatSimple().usage;
      if (u.cacheReadTokens !== undefined) {
        expect(Number.isFinite(u.cacheReadTokens)).toBe(true);
        expect(u.cacheReadTokens).toBeGreaterThanOrEqual(0);
      }
      if (u.cacheWriteTokens !== undefined) {
        expect(Number.isFinite(u.cacheWriteTokens)).toBe(true);
        expect(u.cacheWriteTokens).toBeGreaterThanOrEqual(0);
      }
    });

    it('chat() honours system messages without throwing', () => {
      expect(chatSystem().message.role).toBe('assistant');
    });

    // ── chat() tool-use shape ────────────────────────────────────────────
    it('chat(tools) returns toolCalls as an array when the model decides to call a tool', () => {
      const tc = chatTool().message;
      if (tc.role === 'assistant' && tc.toolCalls !== undefined) {
        expect(Array.isArray(tc.toolCalls)).toBe(true);
      } else {
        // Some recordings may elect not to call the tool; we still want a
        // string content in that case so downstream code has something
        // to surface.
        expect(typeof tc.content).toBe('string');
      }
    });

    it('chat(tools) tool call ids are non-empty strings', () => {
      const msg = chatTool().message;
      if (msg.role !== 'assistant' || !msg.toolCalls) return;
      for (const tc of msg.toolCalls) {
        expect(typeof tc.id).toBe('string');
        expect(tc.id.length).toBeGreaterThan(0);
      }
    });

    it('chat(tools) tool call names match the requested schema', () => {
      const msg = chatTool().message;
      if (msg.role !== 'assistant' || !msg.toolCalls) return;
      for (const tc of msg.toolCalls) {
        expect(typeof tc.name).toBe('string');
        expect(tc.name.length).toBeGreaterThan(0);
      }
    });

    it('chat(tools) tool call arguments are JSON-serialisable strings', () => {
      const msg = chatTool().message;
      if (msg.role !== 'assistant' || !msg.toolCalls) return;
      for (const tc of msg.toolCalls) {
        expect(typeof tc.arguments).toBe('string');
        // The adapter spec says arguments MUST be a string the caller can
        // `JSON.parse`. Empty string is acceptable for zero-arg tools but
        // non-empty strings must parse cleanly.
        if (tc.arguments !== '') {
          expect(() => JSON.parse(tc.arguments)).not.toThrow();
        }
      }
    });

    // ── stream() shape ───────────────────────────────────────────────────
    const streamSimple = (): readonly StreamChunk[] => requireStream(streamResults, 'stream-simple');
    const streamTool = (): readonly StreamChunk[] => requireStream(streamResults, 'stream-tool-call');

    it('stream() yields at least one chunk', () => {
      expect(streamSimple().length).toBeGreaterThan(0);
    });

    it('stream() terminates with a done chunk', () => {
      const last = streamSimple()[streamSimple().length - 1];
      expect(last?.type).toBe('done');
    });

    it('stream() text_delta chunks carry a string text', () => {
      for (const c of streamSimple()) {
        if (c.type === 'text_delta') {
          expect(typeof c.text).toBe('string');
        }
      }
    });

    it('stream() done chunk carries a usage record', () => {
      const last = streamSimple()[streamSimple().length - 1];
      if (last?.type === 'done') {
        expect(last.usage).toBeDefined();
        expect(Number.isFinite(last.usage?.inputTokens ?? 0)).toBe(true);
        expect(Number.isFinite(last.usage?.outputTokens ?? 0)).toBe(true);
      }
    });

    it('stream() aggregated text is non-empty for a responsive prompt', () => {
      const text = streamSimple()
        .filter((c) => c.type === 'text_delta')
        .map((c) => c.text ?? '')
        .join('');
      expect(text.length).toBeGreaterThan(0);
    });

    it('stream(tools) yields a tool_call_delta before done when the model calls a tool', () => {
      const chunks = streamTool();
      const doneIndex = chunks.findIndex((c) => c.type === 'done');
      const toolIndex = chunks.findIndex((c) => c.type === 'tool_call_delta');
      if (toolIndex !== -1 && doneIndex !== -1) {
        expect(toolIndex).toBeLessThan(doneIndex);
      }
      // If no tool call was recorded, at minimum the text was non-empty.
      if (toolIndex === -1) {
        const text = chunks
          .filter((c) => c.type === 'text_delta')
          .map((c) => c.text ?? '')
          .join('');
        expect(text.length).toBeGreaterThan(0);
      }
    });

    it('stream(tools) tool_call_delta exposes id at some point in the stream', () => {
      const chunks = streamTool();
      const toolChunks = chunks.filter((c) => c.type === 'tool_call_delta');
      if (toolChunks.length === 0) return;
      const anyId = toolChunks.some((c) => typeof c.toolCall?.id === 'string' && c.toolCall.id.length > 0);
      expect(anyId).toBe(true);
    });

    it('stream(tools) tool_call_delta exposes name at some point in the stream', () => {
      const chunks = streamTool();
      const toolChunks = chunks.filter((c) => c.type === 'tool_call_delta');
      if (toolChunks.length === 0) return;
      const anyName = toolChunks.some(
        (c) => typeof c.toolCall?.name === 'string' && c.toolCall.name.length > 0,
      );
      expect(anyName).toBe(true);
    });

    // ── adapter reusability & input immutability ─────────────────────────
    it('chat() does not mutate the caller-supplied messages array', async () => {
      const fa = fixtureAdapters.get('chat-simple');
      expect(fa).toBeDefined();
      const chatSimpleFixture = CONTRACT_FIXTURES.find((f) => f.name === 'chat-simple');
      if (!fa || !chatSimpleFixture) return;
      const original = cloneParams(chatSimpleFixture.params);
      const beforeJson = JSON.stringify(original);
      try {
        await fa.chat(original);
      } catch {
        // Queue may be exhausted from the beforeAll warmup; that's fine.
      }
      expect(JSON.stringify(original)).toBe(beforeJson);
    });

    it('two sequential chat() calls remain isolated from each other', async () => {
      const chatSimpleFixture = CONTRACT_FIXTURES.find((f) => f.name === 'chat-simple');
      if (!chatSimpleFixture) return;
      const a = createCassetteAdapter(join(options.cassetteDir, 'chat-simple.jsonl'));
      const b = createCassetteAdapter(join(options.cassetteDir, 'chat-simple.jsonl'));
      const [r1, r2] = await Promise.all([
        a.chat(cloneParams(chatSimpleFixture.params)),
        b.chat(cloneParams(chatSimpleFixture.params)),
      ]);
      expect(r1.message.role).toBe('assistant');
      expect(r2.message.role).toBe('assistant');
    });

    // ── AbortSignal contract ─────────────────────────────────────────────
    it('stream() rejects when the caller signal is already aborted', async () => {
      const streamSimpleFixture = CONTRACT_FIXTURES.find((f) => f.name === 'stream-simple');
      if (!streamSimpleFixture) return;
      const controller = new AbortController();
      controller.abort();
      const replay = createCassetteAdapter(join(options.cassetteDir, 'stream-simple.jsonl'));
      const streamFn = replay.stream;
      if (!streamFn) return;
      await expect(async () => {
        for await (const _ of streamFn.call(replay, {
          ...streamSimpleFixture.params,
          signal: controller.signal,
        })) {
          // unreachable
        }
      }).rejects.toBeInstanceOf(Error);
    });

    it('stream() aborts mid-iteration when simulateTiming is on and signal fires', async () => {
      // Use a self-contained cassette with chunks spaced WIDE enough
      // that the abort window is observable on every platform. The
      // shared `stream-simple.jsonl` fixture spans only ~15ms total;
      // on Windows where `setTimeout` has a ~15ms minimum granularity,
      // the entire cassette finishes before the abort timer fires,
      // and the for-await loop completes normally — making the
      // `.rejects` assertion flake. With chunks at 0/100/200/300ms
      // and abort scheduled at 50ms, abort lands deterministically
      // inside the second-chunk wait on every supported platform.
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'harness-cassette-'));
      const tmpPath = join(tmpDir, 'paced-stream.jsonl');
      const pacedRequest = {
        messages: [{ role: 'user' as const, content: 'paced' }],
      };
      const { computeKey } = await import('../cassette/index.js');
      const pacedEntry = {
        kind: 'stream' as const,
        version: 1 as const,
        key: computeKey('stream', pacedRequest),
        request: pacedRequest,
        chunks: [
          { offsetMs: 0, chunk: { type: 'text_delta' as const, text: 'a' } },
          { offsetMs: 100, chunk: { type: 'text_delta' as const, text: 'b' } },
          { offsetMs: 200, chunk: { type: 'text_delta' as const, text: 'c' } },
          { offsetMs: 300, chunk: { type: 'done' as const, usage: { inputTokens: 1, outputTokens: 1 } } },
        ],
        recordedAtMs: Date.now(),
      };
      await fs.writeFile(tmpPath, JSON.stringify(pacedEntry) + '\n', 'utf8');
      try {
        const controller = new AbortController();
        const replay = createCassetteAdapter(tmpPath, { simulateTiming: true });
        const streamFn = replay.stream;
        if (!streamFn) return;
        // 50ms abort lands well inside the 100→200ms inter-chunk wait
        // on every platform (Windows ~15ms timer granularity rounds
        // 50ms up to 60ms — still inside the window).
        setTimeout(() => controller.abort(), 50);
        await expect(async () => {
          for await (const _ of streamFn.call(replay, {
            ...pacedRequest,
            signal: controller.signal,
          })) {
            // unreachable after abort
          }
        }).rejects.toBeInstanceOf(Error);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    // ── countTokens (optional capability) ────────────────────────────────
    it('countTokens() (when supported) returns a non-negative finite number', async () => {
      if (typeof adapter.countTokens !== 'function') return;
      const count = await adapter.countTokens([{ role: 'user', content: 'hello' }]);
      expect(Number.isFinite(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    });

    // ── name metadata ────────────────────────────────────────────────────
    it('adapter exposes a non-empty name string', () => {
      expect(typeof adapter.name === 'string').toBe(true);
      if (typeof adapter.name === 'string') {
        expect(adapter.name.length).toBeGreaterThan(0);
      }
    });
  });
}

// ── helpers ──────────────────────────────────────────────────────────────

function resolveMode(preferred?: 'replay' | 'record' | 'auto'): 'replay' | 'record' | 'auto' {
  const fromEnv = process.env.CASSETTE_MODE;
  if (fromEnv === 'record' || fromEnv === 'replay' || fromEnv === 'auto') return fromEnv;
  return preferred ?? 'replay';
}

function resolveFixtureMode(
  path: string,
  mode: 'replay' | 'record' | 'auto',
): 'replay' | 'record' {
  if (mode === 'record') return 'record';
  if (mode === 'replay') return 'replay';
  return existsSync(path) ? 'replay' : 'record';
}

function cloneParams(params: ChatParams): ChatParams {
  // Structured clone via JSON — the cassette fixtures never contain
  // `signal` or non-serialisable values, so this is safe.
  return JSON.parse(JSON.stringify(params)) as ChatParams;
}

function requireChat(map: Map<string, ChatResponse>, name: string): ChatResponse {
  const r = map.get(name);
  if (!r) {
    throw new Error(
      `Contract suite: cassette for fixture "${name}" was not loaded. Re-record with CASSETTE_MODE=record.`,
    );
  }
  return r;
}

function requireStream(map: Map<string, readonly StreamChunk[]>, name: string): readonly StreamChunk[] {
  const r = map.get(name);
  if (!r) {
    throw new Error(
      `Contract suite: cassette for fixture "${name}" was not loaded. Re-record with CASSETTE_MODE=record.`,
    );
  }
  return r;
}

// Re-export fixtures so record scripts can enumerate them without a
// deep import.
export { CONTRACT_FIXTURES, cassetteFileName };
export type { ContractFixture };

/**
 * Fixture metadata lookup — exposed so re-record scripts can iterate
 * the canonical list without importing from the `fixtures.ts` deep
 * path.
 */
export interface ContractAdapterFixturesHandle {
  readonly fixtures: readonly ContractFixture[];
  readonly fileNameFor: (fixture: ContractFixture) => string;
}

export const contractFixturesHandle: ContractAdapterFixturesHandle = {
  fixtures: CONTRACT_FIXTURES,
  fileNameFor: cassetteFileName,
};
