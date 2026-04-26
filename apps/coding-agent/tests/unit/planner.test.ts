import { describe, expect, it } from 'vitest';

import {
  buildInitialMessages,
  buildInitialPlan,
  buildSystemPrompt,
} from '../../src/agent/planner.js';

describe('planner', () => {
  it('produces a system prompt that mentions every tool', () => {
    const sp = buildSystemPrompt({
      prompt: 'p',
      workspace: '/tmp/ws',
      toolNames: ['read_file', 'shell'],
      approvalMode: 'auto',
    });
    expect(sp).toContain('read_file');
    expect(sp).toContain('shell');
    expect(sp).toContain('Workspace: /tmp/ws');
    expect(sp).toContain('Approval mode: auto');
  });

  it('includes dry-run notice when active', () => {
    const sp = buildSystemPrompt({
      prompt: 'p',
      workspace: '/tmp/ws',
      toolNames: [],
      approvalMode: 'auto',
      dryRun: true,
    });
    expect(sp).toContain('Dry-run mode');
  });

  it('builds a [system, user] message pair', () => {
    const msgs = buildInitialMessages({
      prompt: 'fix',
      workspace: '/tmp/ws',
      toolNames: ['x'],
      approvalMode: 'auto',
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('fix');
  });

  it('clips long prompt for plan objective', () => {
    const plan = buildInitialPlan('a'.repeat(500));
    expect(plan.objective.length).toBeLessThanOrEqual(200);
    expect(plan.steps).toHaveLength(1);
    expect(plan.status).toBe('draft');
  });
});
