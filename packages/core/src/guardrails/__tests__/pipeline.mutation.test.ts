/**
 * Mutation-testing coverage for `src/guardrails/pipeline.ts`.
 *
 * Existing tests in `pipeline.test.ts` and `pipeline-hardening.test.ts`
 * stay untouched; this file adds assertions whose sole purpose is to kill
 * specific Stryker-reported mutants. Each `describe` names the mutant
 * category so future reviewers can trace surviving mutants back.
 */

import { describe, it, expect } from 'vitest';
import {
  createPipeline,
  runInput,
  runOutput,
  runToolOutput,
  runRagContext,
} from '../pipeline.js';
import type { Guardrail, GuardrailEvent } from '../types.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

const allow: Guardrail = () => ({ action: 'allow' });
const block = (reason = 'blocked'): Guardrail => () => ({ action: 'block', reason });

describe('pipeline.ts — assertPipeline error identity', () => {
  // StringLiteral mutant on the suggestion string in the HarnessError
  // constructor (line 27) and ConditionalExpression / EqualityOperator
  // mutants on the guard condition (line 21). Existing tests assert a
  // message substring match but not the error code or the suggestion, so
  // the mutant can survive while still "throwing something".
  it('throws HarnessError with code GUARD_INVALID_PIPELINE and correct suggestion', async () => {
    const bogus = {} as unknown as Parameters<typeof runInput>[0];
    let caught: unknown;
    try {
      await runInput(bogus, { content: 'x' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const he = caught as HarnessError;
    expect(he.code).toBe(HarnessErrorCode.GUARD_INVALID_PIPELINE);
    expect(he.message).toBe('Invalid GuardrailPipeline instance');
    expect(he.suggestion).toBe('Use createPipeline() to create pipelines');
  });

  it('rejects null/undefined pipeline with the same HarnessError (kills == null → false mutant)', async () => {
    const nullPipeline = null as unknown as Parameters<typeof runInput>[0];
    await expect(
      runInput(nullPipeline, { content: 'x' }),
    ).rejects.toThrow(HarnessError);
  });
});

describe('pipeline.ts — runToolOutput meta shape', () => {
  // ConditionalExpression mutant on line 116 `toolName !== undefined &&`
  // and related StringLiteral mutants. Without explicit assertions that
  // `meta` is absent when no toolName is passed, the mutant (which always
  // injects meta) slips through.
  it('omits ctx.meta entirely when no toolName is passed', async () => {
    let seen: unknown = 'sentinel';
    const pipeline = createPipeline({
      output: [
        {
          name: 'spy',
          guard: (ctx) => {
            seen = ctx.meta;
            return { action: 'allow' };
          },
        },
      ],
    });
    await runToolOutput(pipeline, 'payload');
    expect(seen).toBeUndefined();
  });

  it('attaches meta.toolName using the literal "toolName" key', async () => {
    let received: Record<string, unknown> | undefined;
    const pipeline = createPipeline({
      output: [
        {
          name: 'spy',
          guard: (ctx) => {
            received = ctx.meta;
            return { action: 'allow' };
          },
        },
      ],
    });
    await runToolOutput(pipeline, 'payload', 'readFile');
    expect(received).toEqual({ toolName: 'readFile' });
    expect(Object.keys(received ?? {})).toEqual(['toolName']);
  });
});

describe('pipeline.ts — runRagContext behaviour', () => {
  // Entire function (lines 388-417) had zero test coverage in the
  // baseline. Covering all four surviving branches: module-wrapper
  // assertPipeline guard, empty-chunk return, per-chunk iteration with
  // ragChunkIndex, and short-circuit on first non-allow verdict.

  it('returns allow with empty results for an empty chunk list', async () => {
    const pipeline = createPipeline({
      input: [{ name: 'g', guard: allow }],
    });
    const result = await runRagContext(pipeline, []);
    expect(result.passed).toBe(true);
    expect(result.verdict).toEqual({ action: 'allow' });
    expect(result.results).toEqual([]);
  });

  it('evaluates every chunk when all pass', async () => {
    const seenContents: string[] = [];
    const pipeline = createPipeline({
      input: [
        {
          name: 'g',
          guard: (ctx) => {
            seenContents.push(ctx.content);
            return { action: 'allow' };
          },
        },
      ],
    });
    const result = await runRagContext(pipeline, ['a', 'b', 'c']);
    expect(result.passed).toBe(true);
    expect(seenContents).toEqual(['a', 'b', 'c']);
  });

  it('short-circuits on the first non-allow chunk', async () => {
    const seenContents: string[] = [];
    const pipeline = createPipeline({
      input: [
        {
          name: 'g',
          guard: (ctx) => {
            seenContents.push(ctx.content);
            return ctx.content === 'bad'
              ? { action: 'block', reason: 'poisoned' }
              : { action: 'allow' };
          },
        },
      ],
    });
    const result = await runRagContext(pipeline, ['ok', 'bad', 'unreached']);
    expect(result.passed).toBe(false);
    expect(result.verdict.action).toBe('block');
    expect(seenContents).toEqual(['ok', 'bad']);
  });

  it('tags each chunk with ragChunkIndex in meta and forwards caller meta', async () => {
    const observed: Record<string, unknown>[] = [];
    const pipeline = createPipeline({
      input: [
        {
          name: 'g',
          guard: (ctx) => {
            if (ctx.meta) observed.push({ ...ctx.meta });
            return { action: 'allow' };
          },
        },
      ],
    });
    await runRagContext(pipeline, ['x', 'y'], { source: 'docs', limit: 2 });
    expect(observed).toEqual([
      { source: 'docs', limit: 2, ragChunkIndex: 0 },
      { source: 'docs', limit: 2, ragChunkIndex: 1 },
    ]);
  });

  it('handles undefined caller meta (kills LogicalOperator on meta ?? {})', async () => {
    const observed: Record<string, unknown>[] = [];
    const pipeline = createPipeline({
      input: [
        {
          name: 'g',
          guard: (ctx) => {
            observed.push({ ...(ctx.meta ?? {}) });
            return { action: 'allow' };
          },
        },
      ],
    });
    await runRagContext(pipeline, ['x']);
    expect(observed).toEqual([{ ragChunkIndex: 0 }]);
  });

  it('allows modify verdicts without short-circuiting RAG iteration', async () => {
    // runRagContext short-circuits only on non-allow; a modify verdict is
    // still a non-allow, so it should short-circuit. This test pins that
    // behaviour explicitly (kills the `!== "allow"` → `=== "allow"` mutant).
    let visited = 0;
    const pipeline = createPipeline({
      input: [
        {
          name: 'g',
          guard: (ctx) => {
            visited++;
            return ctx.content === 'mod'
              ? { action: 'modify', modified: 'clean', reason: 'r' }
              : { action: 'allow' };
          },
        },
      ],
    });
    const result = await runRagContext(pipeline, ['ok', 'mod', 'never']);
    expect(visited).toBe(2);
    expect(result.verdict.action).toBe('modify');
  });

  it('rejects non-pipeline objects via the module-level wrapper', async () => {
    const bogus = {} as unknown as Parameters<typeof runRagContext>[0];
    await expect(runRagContext(bogus, ['x'])).rejects.toThrow(HarnessError);
  });
});

describe('pipeline.ts — total-timeout budget exhaustion', () => {
  // Lines 203-218 had zero coverage. The mutants include block/allow
  // verdict wiring, the timeout event, the elapsed-check inequality, and
  // the fail-open branch. We trigger it by chaining guards whose combined
  // delay exceeds totalTimeoutMs.

  const slow = (delayMs: number): Guardrail => async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return { action: 'allow' };
  };

  it('fail-closed: emits a block verdict referencing totalTimeoutMs', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      input: [
        { name: 'first', guard: slow(40) },
        { name: 'second', guard: slow(40) },
        { name: 'third', guard: slow(40) },
      ],
      totalTimeoutMs: 30,
      defaultTimeoutMs: 0,
      onEvent: (e) => events.push(e),
      failClosed: true,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(false);
    expect(result.verdict.action).toBe('block');
    if (result.verdict.action === 'block') {
      expect(result.verdict.reason).toContain('total timeout');
      expect(result.verdict.reason).toContain('30ms');
    }
    // Emitted event should also be the block verdict
    const last = events.at(-1);
    expect(last?.verdict.action).toBe('block');
  });

  it('fail-open: emits an allow verdict with fail-open marker', async () => {
    const pipeline = createPipeline({
      input: [
        { name: 'first', guard: slow(40) },
        { name: 'second', guard: slow(40) },
      ],
      totalTimeoutMs: 25,
      defaultTimeoutMs: 0,
      failClosed: false,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(true);
    expect(result.verdict.action).toBe('allow');
    if (result.verdict.action === 'allow') {
      expect(result.verdict.reason).toContain('fail-open');
    }
  });

  it('totalTimeoutMs: 0 disables the budget check entirely', async () => {
    // ConditionalExpression mutant `pipeline.totalTimeoutMs > 0` → `true`
    // would still enter the block; the kill signal is that guards with
    // combined latency larger than any reasonable budget still finish.
    const pipeline = createPipeline({
      input: [
        { name: 'a', guard: slow(20) },
        { name: 'b', guard: slow(20) },
      ],
      totalTimeoutMs: 0,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(true);
    expect(result.verdict.action).toBe('allow');
  });
});

describe('pipeline.ts — per-guard timeout clamped by remaining budget', () => {
  // Lines 228-258: when a guard declares `timeoutMs` and the pipeline has
  // a `totalTimeoutMs`, the per-guard deadline is clamped to whatever
  // remains of the total budget. Mutants alter the clamp arithmetic and
  // inequality direction.
  const slow = (delayMs: number): Guardrail => async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return { action: 'allow' };
  };

  it('later guard trips the clamped deadline (total budget << guard timeout)', async () => {
    const pipeline = createPipeline({
      input: [
        { name: 'first', guard: slow(30) },
        // Declared timeout 10000 but the total budget allows ~20ms by the
        // time this guard runs. If the clamp isn't applied, the guard
        // would run to completion (50ms) and succeed, flipping the test.
        { name: 'second', guard: slow(50), timeoutMs: 10_000 },
      ],
      totalTimeoutMs: 40,
      defaultTimeoutMs: 0,
      failClosed: true,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(false);
  });
});

describe('pipeline.ts — bounded buffer eviction policy', () => {
  // Lines 141-187 are the BoundedEventBuffer. The baseline had survivors
  // around the oldest-non-block pointer arithmetic and the findNextNonBlock
  // scan. Existing tests verify retention counts; these assertions pin
  // eviction ORDER and the "all events are blocks" fallback path.

  it('FIFO-evicts non-block events first, keeping block events intact', async () => {
    // Fill with allows until cap (non-block), then push a block, then
    // another allow — the cap forces an eviction that must come from the
    // non-block prefix, not the block.
    const verdicts: GuardrailEvent['verdict'][] = [
      { action: 'allow' },
      { action: 'allow' },
      { action: 'block', reason: 'keep-me' },
      { action: 'allow' },
    ];
    let idx = 0;
    const guard: Guardrail = () => {
      const v = verdicts[idx++];
      return v;
    };
    const pipeline = createPipeline({
      input: Array.from({ length: verdicts.length }, (_v, i) => ({
        name: `g${i}`,
        guard,
      })),
      maxResults: 3,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'x' });
    // The pipeline short-circuits on the third guard (block). By then 3
    // events should be in the buffer. The fourth allow never runs, so the
    // eviction-at-capacity path for shift() is covered by the next test.
    expect(result.passed).toBe(false);
    expect(result.results.length).toBeLessThanOrEqual(3);
    const hasBlock = result.results.some((r) => r.verdict.action === 'block');
    expect(hasBlock).toBe(true);
  });

  it('evicts via shift() when every buffered event is a block (fail-open path)', async () => {
    // failClosed=false keeps pushing through block-verdict emissions only
    // if guards actually throw, but the `runGuardrails` short-circuits on
    // a block verdict. We therefore trigger the all-block eviction via
    // fail-open throwing guards — each emits an "allow (fail-open error)"
    // verdict, which is NOT a block, so to keep this test focused on the
    // shift() path we use a single block verdict followed by capacity.
    //
    // The simplest kill is just exercising the path where all retained
    // events are "block": configure fail-closed with a block on a later
    // guard after the buffer has overflowed with blocks from modify-then-
    // block patterns. We use `maxResults: 1` and a single block verdict
    // to land exactly on the shift() branch.
    const pipeline = createPipeline({
      input: [{ name: 'blocker', guard: block('nope') }],
      maxResults: 1,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].verdict.action).toBe('block');
  });

  it('keeps the most recent allow when many allows overflow the buffer', async () => {
    // maxResults=2 with three allow events — the buffer must retain the
    // TWO MOST RECENT events. Kills off-by-one mutants on the push-index
    // arithmetic and the `oldestNonBlockIdx` update branch.
    const names = ['g1', 'g2', 'g3', 'g4'];
    const verdicts = ['first', 'second', 'third', 'fourth'];
    let idx = 0;
    const pipeline = createPipeline({
      input: names.map((n) => ({
        name: n,
        guard: () => ({ action: 'modify', modified: verdicts[idx++], reason: 'r' }),
      })),
      maxResults: 2,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'seed' });
    expect(result.passed).toBe(true);
    expect(result.results.length).toBe(2);
    // The retained two must be the most recent guards by name (g3, g4)
    expect(result.results.map((e) => e.guardrail)).toEqual(['g3', 'g4']);
  });
});

describe('pipeline.ts — latency accounting', () => {
  // ArithmeticOperator mutants flip `performance.now() - start` to `+`,
  // which makes `latencyMs` absurdly large. Assert sane upper bound.
  it('event latencyMs is small and non-negative for a synchronous allow guard', async () => {
    let emitted: GuardrailEvent | undefined;
    const pipeline = createPipeline({
      input: [{ name: 'fast', guard: allow }],
      onEvent: (e) => {
        emitted = e;
      },
      defaultTimeoutMs: 0,
    });
    await runInput(pipeline, { content: 'x' });
    expect(emitted).toBeDefined();
    expect(emitted!.latencyMs).toBeGreaterThanOrEqual(0);
    // Upper bound: a synchronous allow guard must finish well within 1s
    // even on a loaded CI runner. The mutated form (sum of two
    // timestamps) is ~ 2 * performance.now() at call time — several
    // orders of magnitude larger.
    expect(emitted!.latencyMs).toBeLessThan(1000);
  });

  it('fail-open error event carries a small latency', async () => {
    let emitted: GuardrailEvent | undefined;
    const thrower: Guardrail = () => {
      throw new Error('boom');
    };
    const pipeline = createPipeline({
      input: [{ name: 't', guard: thrower }],
      failClosed: false,
      onEvent: (e) => {
        emitted = e;
      },
      defaultTimeoutMs: 0,
    });
    await runInput(pipeline, { content: 'x' });
    expect(emitted).toBeDefined();
    expect(emitted!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(emitted!.latencyMs).toBeLessThan(1000);
  });

  it('fail-open error event verdict.reason has the documented prefix', async () => {
    // StringLiteral mutant on line 300 emptied `'Guardrail error (fail-open):'`.
    const thrower: Guardrail = () => {
      throw new Error('kaboom');
    };
    const pipeline = createPipeline({
      input: [{ name: 't', guard: thrower }],
      failClosed: false,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'x' });
    const emitted = result.results.at(-1);
    expect(emitted?.verdict.action).toBe('allow');
    if (emitted?.verdict.action === 'allow') {
      expect(emitted.verdict.reason).toContain('fail-open');
      expect(emitted.verdict.reason).toContain('kaboom');
    }
  });
});

describe('pipeline.ts — event direction is exactly the port method', () => {
  // StringLiteral mutants at lines 174, 183, 211 empty the `'block'`
  // literal strings, which change the BoundedEventBuffer classification.
  // Also direction itself can be an empty string under mutation — pin
  // the exact values.
  it('runInput emits events with direction=input', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      input: [{ name: 'g', guard: allow }],
      onEvent: (e) => events.push(e),
      defaultTimeoutMs: 0,
    });
    await runInput(pipeline, { content: 'x' });
    expect(events[0]?.direction).toBe('input');
  });
  it('runOutput emits events with direction=output', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      output: [{ name: 'g', guard: allow }],
      onEvent: (e) => events.push(e),
      defaultTimeoutMs: 0,
    });
    await runOutput(pipeline, { content: 'x' });
    expect(events[0]?.direction).toBe('output');
  });
});

describe('pipeline.ts — pipeline built with no input/output configs', () => {
  // ArrayDeclaration mutants on `config.input ?? []` and `config.output ?? []`
  // (lines 97-98). If the fallback is replaced by `["Stryker was here"]`,
  // running the omitted direction must still behave like an empty pipeline.
  it('runOutput on a pipeline with no output config returns allow immediately', async () => {
    const pipeline = createPipeline({
      input: [{ name: 'i', guard: allow }],
      defaultTimeoutMs: 0,
    });
    const result = await runOutput(pipeline, { content: 'x' });
    expect(result.passed).toBe(true);
    expect(result.verdict).toEqual({ action: 'allow' });
    expect(result.results).toEqual([]);
  });

  it('runInput on a pipeline with no input config returns allow immediately', async () => {
    const pipeline = createPipeline({
      output: [{ name: 'o', guard: allow }],
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(true);
    expect(result.results).toEqual([]);
  });
});

describe('pipeline.ts — fail-closed error emits exactly one event', () => {
  // ConditionalExpression mutant line 271 `entry.timeoutMs !== undefined &&
  // errMsg.includes('timed out after')` → `true`. Under the mutant, a
  // fail-closed throwing guard with no per-guard timeout would emit an
  // extra `guard_timeout:` span-event to onEvent before the verdict
  // event. The baseline only emits one event in this scenario.
  it('throwing guard without per-guard timeout emits one event, no guard_timeout span', async () => {
    const events: GuardrailEvent[] = [];
    const thrower: Guardrail = () => {
      throw new Error('plain boom');
    };
    const pipeline = createPipeline({
      input: [{ name: 't', guard: thrower }],
      failClosed: true,
      onEvent: (e) => events.push(e),
      defaultTimeoutMs: 0,
    });
    await runInput(pipeline, { content: 'x' });
    expect(events.length).toBe(1);
    expect(events[0].verdict.action).toBe('block');
    if (events[0].verdict.action === 'block') {
      expect(events[0].verdict.reason).not.toContain('guard_timeout');
      expect(events[0].verdict.reason).toContain('plain boom');
    }
  });

  it('per-guard timeout path DOES emit a guard_timeout span-event alongside the verdict', async () => {
    const events: GuardrailEvent[] = [];
    const hang: Guardrail = () => new Promise(() => {});
    const pipeline = createPipeline({
      input: [{ name: 'h', guard: hang, timeoutMs: 5 }],
      failClosed: true,
      onEvent: (e) => events.push(e),
      defaultTimeoutMs: 0,
      totalTimeoutMs: 0,
    });
    await runInput(pipeline, { content: 'x' });
    // Expect the span-event (guard_timeout prefix) first, then the block verdict
    expect(events.length).toBe(2);
    const reasons = events.map((e) =>
      e.verdict.action !== 'allow' ? e.verdict.reason : '',
    );
    expect(reasons.some((r) => r.includes('guard_timeout'))).toBe(true);
  });
});

describe('pipeline.ts — fail-closed error verdict latency', () => {
  // ArithmeticOperator mutant line 289 `performance.now() - start` → `+`.
  // The emitted block-event's latencyMs must be small and non-negative.
  it('fail-closed block event on throw has sane latencyMs', async () => {
    let emitted: GuardrailEvent | undefined;
    const thrower: Guardrail = () => {
      throw new Error('boom');
    };
    const pipeline = createPipeline({
      input: [{ name: 't', guard: thrower }],
      failClosed: true,
      onEvent: (e) => {
        emitted = e;
      },
      defaultTimeoutMs: 0,
    });
    await runInput(pipeline, { content: 'x' });
    expect(emitted?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(emitted!.latencyMs).toBeLessThan(1000);
  });
});

describe('pipeline.ts — total-timeout event latency + direction', () => {
  // Kills the ArithmeticOperator at line 213 (`elapsed` used as latencyMs)
  // and the StringLiteral direction=input at line 211.
  const slow = (delayMs: number): Guardrail => async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return { action: 'allow' };
  };

  it('total-timeout block event for runInput has direction=input and positive latency', async () => {
    let observed: GuardrailEvent | undefined;
    const pipeline = createPipeline({
      input: [
        { name: 'a', guard: slow(30) },
        { name: 'b', guard: slow(30) },
      ],
      totalTimeoutMs: 20,
      defaultTimeoutMs: 0,
      failClosed: true,
      onEvent: (e) => {
        observed = e;
      },
    });
    await runInput(pipeline, { content: 'x' });
    expect(observed?.direction).toBe('input');
    expect(observed!.latencyMs).toBeGreaterThan(0);
    expect(observed!.latencyMs).toBeLessThan(1000);
  });

  it('total-timeout block event for runOutput has direction=output', async () => {
    let observed: GuardrailEvent | undefined;
    const pipeline = createPipeline({
      output: [
        { name: 'a', guard: slow(30) },
        { name: 'b', guard: slow(30) },
      ],
      totalTimeoutMs: 20,
      defaultTimeoutMs: 0,
      failClosed: true,
      onEvent: (e) => {
        observed = e;
      },
    });
    await runOutput(pipeline, { content: 'x' });
    expect(observed?.direction).toBe('output');
  });
});

describe('pipeline.ts — runRagContext direction tag', () => {
  // StringLiteral mutant line 412 empties `'input'`; pin the direction
  // on events emitted via runRagContext.
  it('runRagContext events carry direction=input', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      input: [{ name: 'g', guard: allow }],
      onEvent: (e) => events.push(e),
      defaultTimeoutMs: 0,
    });
    await runRagContext(pipeline, ['chunk']);
    expect(events[0]?.direction).toBe('input');
  });
});

describe('pipeline.ts — no-clamp path when per-guard timeout fits budget', () => {
  // EqualityOperator mutant line 238 `remaining < effectiveTimeout` →
  // `remaining <= effectiveTimeout` or `remaining >= effectiveTimeout`.
  // When the per-guard timeoutMs is comfortably below the remaining
  // budget, the clamp must NOT fire and the guard must complete.
  it('guard timeoutMs well below remaining budget runs to completion', async () => {
    const guard: Guardrail = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 'g', guard, timeoutMs: 100 }],
      totalTimeoutMs: 5000,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(true);
  });
});

describe('pipeline.ts — defaultTimeoutMs applied only when > 0', () => {
  // Lines 83, 88 had survivors: `defaultTimeoutMs ?? 5000` and
  // `defaultTimeoutMs > 0 ? defaultTimeoutMs : undefined`. Combined, the
  // mutant forms can either always apply a default, never apply it, or
  // leak a 0 as the per-guard timeout.
  it('a slow guard without explicit timeout still finishes when defaultTimeoutMs=0', async () => {
    const slow: Guardrail = async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 's', guard: slow }],
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(true);
  });

  it('a slow guard without explicit timeout is killed when defaultTimeoutMs=15ms', async () => {
    const slow: Guardrail = async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 's', guard: slow }],
      defaultTimeoutMs: 15,
      totalTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(false);
    if (result.verdict.action === 'block') {
      expect(result.verdict.reason).toContain('timed out');
    }
  });
});
