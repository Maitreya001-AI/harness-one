/**
 * Tests for the W3-C5 type-and-runtime tightening pass on
 * `createPipeline` / `GuardrailContext` / `getRejectionReason`.
 *
 * Closes:
 *   - HARNESS_LOG HC-003 — `createPipeline` runtime entry validation
 *   - HARNESS_LOG L-002  — `GuardrailContext.direction` auto-fill
 *   - showcase 02       — `getRejectionReason` helper
 */
import { describe, it, expect } from 'vitest';
import { createPipeline, getRejectionReason } from '../pipeline.js';
import type {
  Guardrail,
  GuardrailContext,
  GuardrailVerdict,
  SyncGuardrail,
} from '../types.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

const allow: SyncGuardrail = () => ({ action: 'allow' });
const block: SyncGuardrail = () => ({ action: 'block', reason: 'bad' });

describe('createPipeline — entry validation (HC-003)', () => {
  it('throws GUARD_INVALID_PIPELINE when an entry is a bare function', () => {
    let caught: unknown;
    try {
      // Caller bypassed TS via `as never`. The runtime check still rejects.
      createPipeline({ input: [allow as never] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe(HarnessErrorCode.GUARD_INVALID_PIPELINE);
  });

  it('throws when an entry has no name', () => {
    expect(() =>
      createPipeline({ input: [{ guard: allow } as unknown as { name: string; guard: Guardrail }] }),
    ).toThrow(HarnessError);
  });

  it('throws when an entry has empty name', () => {
    expect(() =>
      createPipeline({ input: [{ name: '', guard: allow }] }),
    ).toThrow(/non-empty/);
  });

  it('throws when an entry has no guard function', () => {
    expect(() =>
      createPipeline({
        input: [{ name: 'x', guard: 'not a function' as unknown as Guardrail }],
      }),
    ).toThrow(/Guardrail function/);
  });

  it('accepts well-formed entries', () => {
    expect(() =>
      createPipeline({ input: [{ name: 'g', guard: allow }] }),
    ).not.toThrow();
  });

  it('also validates entries on the output side', () => {
    expect(() =>
      createPipeline({ output: [allow as never] }),
    ).toThrow(HarnessError);
  });
});

describe('GuardrailContext.direction auto-fill (L-002)', () => {
  it('runInput injects direction="input" before the guardrail runs', async () => {
    let seenDirection: GuardrailContext['direction'];
    const probe: SyncGuardrail = (ctx) => {
      seenDirection = ctx.direction;
      return { action: 'allow' };
    };
    const p = createPipeline({ input: [{ name: 'probe', guard: probe }] });
    await p.runInput({ content: 'hello' });
    expect(seenDirection).toBe('input');
  });

  it('runOutput injects direction="output"', async () => {
    let seenDirection: GuardrailContext['direction'];
    const probe: SyncGuardrail = (ctx) => {
      seenDirection = ctx.direction;
      return { action: 'allow' };
    };
    const p = createPipeline({ output: [{ name: 'probe', guard: probe }] });
    await p.runOutput({ content: 'hello' });
    expect(seenDirection).toBe('output');
  });

  it('preserves caller-supplied direction (override)', async () => {
    let seenDirection: GuardrailContext['direction'];
    const probe: SyncGuardrail = (ctx) => {
      seenDirection = ctx.direction;
      return { action: 'allow' };
    };
    const p = createPipeline({ input: [{ name: 'probe', guard: probe }] });
    await p.runInput({ content: 'hello', direction: 'tool_output' });
    expect(seenDirection).toBe('tool_output');
  });

  it('source field passes through verbatim', async () => {
    let seenSource: string | undefined;
    const probe: SyncGuardrail = (ctx) => {
      seenSource = ctx.source;
      return { action: 'allow' };
    };
    const p = createPipeline({ input: [{ name: 'probe', guard: probe }] });
    await p.runInput({ content: 'hello', source: 'web_fetch:https://example.com' });
    expect(seenSource).toBe('web_fetch:https://example.com');
  });
});

describe('getRejectionReason — verdict reason extraction (showcase 02)', () => {
  it('returns the reason for block verdicts', async () => {
    const p = createPipeline({ input: [{ name: 'b', guard: block }] });
    const result = await p.runInput({ content: 'x' });
    expect(getRejectionReason(result)).toBe('bad');
  });

  it('returns undefined for allow verdicts', async () => {
    const p = createPipeline({ input: [{ name: 'a', guard: allow }] });
    const result = await p.runInput({ content: 'x' });
    expect(getRejectionReason(result)).toBeUndefined();
  });

  it('returns reason for modify verdicts', async () => {
    const modifier: SyncGuardrail = (): GuardrailVerdict => ({
      action: 'modify',
      modified: 'CLEAN',
      reason: 'redacted PII',
    });
    const p = createPipeline({ input: [{ name: 'm', guard: modifier }] });
    const result = await p.runInput({ content: 'x' });
    expect(getRejectionReason(result)).toBe('redacted PII');
  });
});
