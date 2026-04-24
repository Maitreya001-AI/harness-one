/**
 * O1 — Tool-arguments parser fuzz suite.
 *
 * Exercises the two places a hostile or buggy LLM can hand us arbitrary
 * text that we then `JSON.parse`:
 *
 *   1. `createJsonOutputParser()` from `core/output-parser.ts` — the
 *      public structured-output parser. Wrapped by `parseWithRetry` in
 *      user code; any unhandled throw here propagates across the retry
 *      boundary and trips the caller's telemetry.
 *   2. `createRegistry().execute()` — registry admits a tool call whose
 *      `arguments` is a raw string; `admitCallForExecution` runs
 *      `JSON.parse` inside a try/catch to produce a `toolError`.
 *
 * Survival properties (the invariants fuzzing tries to break):
 *   P1  parser never raises an unhandled exception — every failure path
 *       surfaces as `HarnessError` (output parser) or a `ToolResult`
 *       `error` (registry).
 *   P2  successfully-parsed results never contain a `__proto__` key that
 *       poisons `Object.prototype`. `JSON.parse` is already safe on modern
 *       engines but we assert explicitly so a future "hand-rolled parser"
 *       refactor can't regress silently.
 *   P3  errors produced by the parser are JSON-serialisable. If a
 *       HarnessError carried a non-serialisable cause, downstream telemetry
 *       would itself throw — which is exactly the failure mode observe
 *       pipelines are least able to recover from.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { createJsonOutputParser } from '../../src/core/output-parser.js';
import { createRegistry } from '../../src/tools/registry.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { HarnessError } from '../../src/core/errors.js';
import { toolSuccess } from '../../src/tools/types.js';

const NUM_RUNS = 5000;
const CORPUS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'corpus/tool-args');

// A sacrificial clone of Object.prototype so tests can assert the null-
// prototype "safety net" holds without permanently poisoning the process.
function assertNoProtoPollution(): void {
  // The whole test process would explode long before this fires; the
  // assertion exists so a regression is caught with a clear message.
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
}

function deepObject(depth: number): string {
  let s = '';
  for (let i = 0; i < depth; i++) s += '{"a":';
  s += '1';
  for (let i = 0; i < depth; i++) s += '}';
  return s;
}

function deepArray(depth: number): string {
  return '['.repeat(depth) + '1' + ']'.repeat(depth);
}

function loadCorpus(): Array<{ name: string; content: string }> {
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json'));
  return files.map((name) => ({
    name,
    content: readFileSync(join(CORPUS_DIR, name), 'utf8'),
  }));
}

describe('O1 · tool-arguments parser', () => {
  const parser = createJsonOutputParser();

  describe('seed corpus', () => {
    const samples = loadCorpus();

    for (const sample of samples) {
      it(`output parser survives ${sample.name}`, () => {
        try {
          parser.parse(sample.content);
        } catch (err) {
          // Parser is contractually allowed to throw HarnessError only.
          expect(err).toBeInstanceOf(HarnessError);
        }
        assertNoProtoPollution();
      });
    }

    it('registry surfaces corpus parse failures as toolError (never throws)', async () => {
      const registry = createRegistry({
        allowedCapabilities: ['readonly'],
      });
      registry.register(
        defineTool({
          name: 'echo',
          description: 'echo',
          parameters: { type: 'object' },
          capabilities: ['readonly'],
          execute: async (p) => toolSuccess(JSON.stringify(p)),
        }),
      );

      for (const sample of samples) {
        const out = await registry.execute({
          id: `s_${sample.name}`,
          name: 'echo',
          arguments: sample.content,
        });
        // Either the call was admitted (happens for corpus samples that
        // parse into a legit object like `proto-pollution-*`) or it was
        // rejected with a structured tool error. The fuzz target's only
        // invariant is "never an unhandled throw".
        expect(typeof out).toBe('object');
        expect(out).not.toBeNull();
      }
      assertNoProtoPollution();
    });

    it('registry does not leak __proto__ fields from a parsed object', async () => {
      const registry = createRegistry({ allowedCapabilities: ['readonly'] });
      let seenParams: unknown;
      registry.register(
        defineTool({
          name: 'capture',
          description: 'capture',
          parameters: { type: 'object' },
          capabilities: ['readonly'],
          execute: async (p) => {
            seenParams = p;
            return toolSuccess('ok');
          },
        }),
      );
      // `{"__proto__": {"polluted": true}}` parsed by V8 becomes an object
      // whose *own* `__proto__` property never populates — the parser
      // assigns onto the object's (hidden) __proto__ slot, so the key is
      // silently dropped. We still assert prototype chain stays pristine.
      await registry.execute({
        id: 'proto',
        name: 'capture',
        arguments: '{"__proto__":{"polluted":true}}',
      });
      const proto = Object.getPrototypeOf({} as Record<string, unknown>) as Record<
        string,
        unknown
      >;
      expect(proto.polluted).toBeUndefined();
      // Parsed params must not expose the attacker key at the object's
      // own-property level. If V8 ever changes this semantic, we want to
      // know before shipping.
      if (seenParams && typeof seenParams === 'object') {
        const own = Object.getOwnPropertyNames(seenParams as object);
        expect(own).not.toContain('polluted');
      }
      assertNoProtoPollution();
    });
  });

  describe('depth-bomb samples', () => {
    it.each([
      ['object', 1_500],
      ['array', 1_500],
    ])('does not stack-overflow on a %s nested %i deep', (kind, depth) => {
      const doc = kind === 'object' ? deepObject(depth) : deepArray(depth);
      try {
        parser.parse(doc);
      } catch (err) {
        // V8's own JSON.parse handles large depths iteratively, so this
        // normally succeeds. A HarnessError wrapping a SyntaxError is
        // acceptable; a RangeError/InternalError would indicate the hot
        // path grew a recursive helper.
        expect(err).toBeInstanceOf(HarnessError);
      }
      assertNoProtoPollution();
    });
  });

  describe('property-based', () => {
    it(
      'output parser never throws anything except HarnessError',
      () => {
        fc.assert(
          fc.property(fc.string({ maxLength: 4096 }), (s) => {
            try {
              parser.parse(s);
            } catch (err) {
              if (!(err instanceof HarnessError)) {
                // Surfacing the offending input via the thrown Error
                // message keeps fast-check's shrinker output informative.
                throw new Error(
                  `unexpected throw: ${err instanceof Error ? err.message : String(err)} on input ${JSON.stringify(s).slice(0, 200)}`,
                );
              }
            }
          }),
          { numRuns: NUM_RUNS },
        );
        assertNoProtoPollution();
      },
      120_000,
    );

    it(
      'parsed legal JSON round-trips through JSON.stringify (no non-serialisable exotic)',
      () => {
        // NB: `fc.json()` occasionally emits documents whose root is a
        // string literal containing a triple-backtick (` ``` `) — the
        // output parser's markdown-aware path treats that as an open
        // code block and throws CORE_PARSE_UNCLOSED_CODEBLOCK. That's a
        // documented limitation of the parser, not a survival-property
        // violation, so we accept HarnessError here and just assert the
        // serialisable property when a value actually comes back.
        fc.assert(
          fc.property(fc.json({ maxDepth: 6 }), (s) => {
            let value: unknown;
            try {
              value = parser.parse(s);
            } catch (err) {
              expect(err).toBeInstanceOf(HarnessError);
              return;
            }
            // Guard against parsers that return non-POJOs with throwing
            // getters — JSON.stringify would blow up downstream.
            expect(() => JSON.stringify(value)).not.toThrow();
          }),
          { numRuns: NUM_RUNS },
        );
      },
      120_000,
    );

    it(
      'registry always returns a ToolResult (never throws) on arbitrary argument strings',
      async () => {
        // Registry is stateful (per-turn / per-session counters), so a
        // single instance would saturate after ~20 calls. Rebuild per
        // property evaluation — the cost is negligible vs. the fuzz body.
        await fc.assert(
          fc.asyncProperty(fc.string({ maxLength: 2048 }), async (args) => {
            const registry = createRegistry({
              allowedCapabilities: ['readonly'],
              maxCallsPerTurn: 1_000_000,
              maxCallsPerSession: 1_000_000,
            });
            registry.register(
              defineTool({
                name: 'noop',
                description: 'noop',
                parameters: { type: 'object' },
                capabilities: ['readonly'],
                execute: async () => toolSuccess('ok'),
              }),
            );
            const result = await registry.execute({
              id: 'x',
              name: 'noop',
              arguments: args,
            });
            // Contract: `ToolResult` is either success or error, never
            // thrown. Asserting the shape catches future regressions
            // where a refactor accidentally surfaces raw JS errors.
            expect(result === null || typeof result === 'object').toBe(true);
          }),
          { numRuns: 1_000 }, // registry path is slower; keep the bulk of the budget on the pure parser.
        );
        assertNoProtoPollution();
      },
      120_000,
    );

    it(
      'number-edge strings produce legal JS numbers or a HarnessError',
      () => {
        const edgeNumberStrings = fc.oneof(
          fc.constant('9007199254740993'), // MAX_SAFE_INTEGER + 1
          fc.constant('-9007199254740993'),
          fc.constant('1e400'), // overflows to Infinity
          fc.constant('-1e400'),
          fc.constant('1e-400'), // underflows to 0
          fc.constant('-0'),
          fc.constant('NaN'), // not legal JSON — must surface as HarnessError
          fc.constant('Infinity'),
          fc.constant('0x1'),
          fc.constant('.5'),
          fc.constant('5.'),
        );
        fc.assert(
          fc.property(edgeNumberStrings, (s) => {
            let parsed: unknown;
            try {
              parsed = parser.parse(s);
            } catch (err) {
              expect(err).toBeInstanceOf(HarnessError);
              return;
            }
            // If it did parse, the value must be a JS number (possibly
            // Infinity or 0) — we accept the lossy coercion but not a
            // string or an object sneaking through.
            expect(typeof parsed).toBe('number');
          }),
          { numRuns: 200 },
        );
      },
      60_000,
    );
  });
});
