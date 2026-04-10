import { describe, it, expect, beforeEach } from 'vitest';
import { createContextBoundary } from '../context-boundary.js';
import { createOrchestrator } from '../orchestrator.js';
import type { SharedContext, BoundedContext } from '../types.js';
import { HarnessError } from '../../core/errors.js';

describe('createContextBoundary', () => {
  let context: SharedContext;
  let boundary: BoundedContext;

  beforeEach(() => {
    const orch = createOrchestrator();
    context = orch.context;
    context.set('shared.a', 1);
    context.set('shared.b', 2);
    context.set('config.secret', 'top-secret');
    context.set('other.x', 99);
  });

  it('no policy = full read/write access', () => {
    boundary = createContextBoundary(context);
    const view = boundary.forAgent('unknown-agent');

    expect(view.get('shared.a')).toBe(1);
    expect(view.get('config.secret')).toBe('top-secret');
    view.set('new.key', 'value');
    expect(context.get('new.key')).toBe('value');
  });

  it('allowRead prefix filters reads correctly', () => {
    boundary = createContextBoundary(context, [
      { agent: 'worker', allowRead: ['shared.'] },
    ]);
    const view = boundary.forAgent('worker');

    expect(view.get('shared.a')).toBe(1);
    expect(view.get('config.secret')).toBeUndefined();
  });

  it('denyRead takes precedence over allowRead', () => {
    boundary = createContextBoundary(context, [
      { agent: 'worker', allowRead: ['shared.'], denyRead: ['shared.b'] },
    ]);
    const view = boundary.forAgent('worker');

    expect(view.get('shared.a')).toBe(1);
    expect(view.get('shared.b')).toBeUndefined();
  });

  it('allowWrite prefix filters writes correctly', () => {
    boundary = createContextBoundary(context, [
      { agent: 'worker', allowWrite: ['shared.'] },
    ]);
    const view = boundary.forAgent('worker');

    view.set('shared.new', 'ok');
    expect(context.get('shared.new')).toBe('ok');

    expect(() => view.set('config.x', 'bad')).toThrow(HarnessError);
  });

  it('denyWrite throws HarnessError on write', () => {
    boundary = createContextBoundary(context, [
      { agent: 'worker', denyWrite: ['config.'] },
    ]);
    const view = boundary.forAgent('worker');

    expect(() => view.set('config.secret', 'hacked')).toThrow(HarnessError);
    expect(() => view.set('config.secret', 'hacked')).toThrow(/denied write access/);
    view.set('shared.a', 999);
    expect(context.get('shared.a')).toBe(999);
  });

  it('entries() returns only readable keys', () => {
    boundary = createContextBoundary(context, [
      { agent: 'worker', allowRead: ['shared.'] },
    ]);
    const view = boundary.forAgent('worker');
    const entries = view.entries();

    expect(entries.size).toBe(2);
    expect(entries.has('shared.a')).toBe(true);
    expect(entries.has('shared.b')).toBe(true);
    expect(entries.has('config.secret')).toBe(false);
  });

  it('violation tracking records denied reads and writes', () => {
    boundary = createContextBoundary(context, [
      { agent: 'worker', allowRead: ['shared.'], denyWrite: ['config.'] },
    ]);
    const view = boundary.forAgent('worker');

    view.get('config.secret'); // read denied
    try { view.set('config.x', 'bad'); } catch { /* expected */ }

    const violations = boundary.getViolations();
    expect(violations).toHaveLength(2);
    expect(violations[0]!.type).toBe('read_denied');
    expect(violations[1]!.type).toBe('write_denied');
  });

  it('max 1000 violations (circular buffer)', () => {
    boundary = createContextBoundary(context, [
      { agent: 'worker', allowRead: ['none.'] },
    ]);
    const view = boundary.forAgent('worker');

    for (let i = 0; i < 1010; i++) {
      view.get('shared.a'); // each triggers a read_denied violation
    }

    expect(boundary.getViolations()).toHaveLength(1000);
  });

  it('setPolicies() invalidates cached views', () => {
    boundary = createContextBoundary(context, [
      { agent: 'worker', allowRead: ['shared.'] },
    ]);
    const view1 = boundary.forAgent('worker');
    expect(view1.get('config.secret')).toBeUndefined();

    boundary.setPolicies([{ agent: 'worker' }]);
    const view2 = boundary.forAgent('worker');
    expect(view2.get('config.secret')).toBe('top-secret');
    expect(view2).not.toBe(view1);
  });

  it('getPolicies() returns correct policy', () => {
    const policy = { agent: 'worker', allowRead: ['shared.'] };
    boundary = createContextBoundary(context, [policy]);

    expect(boundary.getPolicies('worker')).toEqual(policy);
    expect(boundary.getPolicies('unknown')).toBeUndefined();
  });
});
