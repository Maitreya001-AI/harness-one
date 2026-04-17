/**
 * Unit tests for the extracted readonly-trace view builder. Pins the
 * back-compat mapping behaviour previously inlined in trace-manager.ts
 * — specifically, the `metadata` / `userMetadata` / `systemMetadata`
 * merging rules and the span-snapshot semantics.
 */

import { describe, it, expect } from 'vitest';
import {
  toReadonlyTrace,
  type ViewableMutableSpan,
  type ViewableMutableTrace,
} from '../trace-view.js';

function makeTrace(overrides: Partial<ViewableMutableTrace> = {}): ViewableMutableTrace {
  return {
    id: 't1',
    name: 'test',
    startTime: 1,
    userMetadata: {},
    systemMetadata: {},
    spanIds: [],
    status: 'running',
    ...overrides,
  };
}

function makeSpan(overrides: Partial<ViewableMutableSpan> = {}): ViewableMutableSpan {
  return {
    id: 's1',
    traceId: 't1',
    name: 'span',
    startTime: 2,
    attributes: {},
    events: [],
    status: 'running',
    ...overrides,
  };
}

describe('toReadonlyTrace', () => {
  it('snapshots basic shape', () => {
    const mt = makeTrace({ endTime: 10, status: 'completed' });
    const t = toReadonlyTrace(mt, () => undefined);
    expect(t.id).toBe('t1');
    expect(t.status).toBe('completed');
    expect(t.endTime).toBe(10);
  });

  it('preserves back-compat: metadata mirrors userMetadata when no system metadata', () => {
    const mt = makeTrace({ userMetadata: { foo: 'bar' } });
    const t = toReadonlyTrace(mt, () => undefined);
    expect(t.metadata).toEqual({ foo: 'bar' });
  });

  it('exposes systemMetadata under __system__ inside metadata when present', () => {
    const mt = makeTrace({
      userMetadata: { user: 'x' },
      systemMetadata: { sys: 'y' },
    });
    const t = toReadonlyTrace(mt, () => undefined);
    expect(t.metadata).toEqual({
      user: 'x',
      __system__: { sys: 'y' },
    });
  });

  it('does not include __system__ when systemMetadata is empty', () => {
    const mt = makeTrace({ userMetadata: { user: 'x' } });
    const t = toReadonlyTrace(mt, () => undefined);
    expect(t.metadata).not.toHaveProperty('__system__');
  });

  it('embeds resolved spans in insertion order', () => {
    const span1 = makeSpan({ id: 's1', name: 'a' });
    const span2 = makeSpan({ id: 's2', name: 'b' });
    const lookup = (id: string): ViewableMutableSpan | undefined =>
      id === 's1' ? span1 : id === 's2' ? span2 : undefined;
    const mt = makeTrace({ spanIds: ['s1', 's2'] });
    const t = toReadonlyTrace(mt, lookup);
    expect(t.spans.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('drops span ids that fail lookup (e.g. post-eviction) instead of embedding null', () => {
    const span1 = makeSpan({ id: 's1' });
    const lookup = (id: string): ViewableMutableSpan | undefined =>
      id === 's1' ? span1 : undefined;
    const mt = makeTrace({ spanIds: ['s1', 's-missing'] });
    const t = toReadonlyTrace(mt, lookup);
    expect(t.spans.map((s) => s.id)).toEqual(['s1']);
  });

  it('clones span events so caller mutations do not bleed back', () => {
    const spanEvents = [{ name: 'e1', timestamp: 1 }] as const;
    const span = makeSpan({ events: spanEvents });
    const mt = makeTrace({ spanIds: ['s1'] });
    const t = toReadonlyTrace(mt, () => span);
    (t.spans[0]?.events as Array<unknown>).push({ name: 'intruder', timestamp: 2 });
    // Source array unaffected.
    expect(spanEvents).toHaveLength(1);
  });

  it('clones userMetadata/systemMetadata so caller mutations do not bleed back', () => {
    const user = { count: 1 };
    const sys = { sys: 1 };
    const mt = makeTrace({ userMetadata: user, systemMetadata: sys });
    const t = toReadonlyTrace(mt, () => undefined) as {
      userMetadata: Record<string, unknown>;
      systemMetadata: Record<string, unknown>;
    };
    t.userMetadata.count = 999;
    t.systemMetadata.sys = 999;
    expect(user.count).toBe(1);
    expect(sys.sys).toBe(1);
  });
});
