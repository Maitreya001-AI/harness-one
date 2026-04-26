import { describe, expect, it } from 'vitest';

import { createTaskId } from '../../src/agent/ids.js';

describe('createTaskId', () => {
  it('begins with task_ prefix', () => {
    expect(createTaskId()).toMatch(/^task_\d+_[a-f0-9]+$/);
  });

  it('produces unique ids on consecutive calls', () => {
    expect(createTaskId()).not.toBe(createTaskId());
  });

  it('honours custom now seam for prefix component', () => {
    const id = createTaskId(() => 42);
    expect(id.startsWith('task_42_')).toBe(true);
  });
});
