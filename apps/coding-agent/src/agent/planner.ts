/**
 * Coding-agent planner.
 *
 * MVP scope per DESIGN §3.4 — the planner does not call the LLM
 * separately; it builds the system + user prompt that primes the
 * AgentLoop and produces an initial single-step plan. The LLM does the
 * actual decomposition during the first iteration of `executing`.
 *
 * @module
 */

import type { Message } from 'harness-one/core';

import type { TaskPlan } from './types.js';

export interface InitialPromptOptions {
  readonly prompt: string;
  readonly workspace: string;
  readonly toolNames: readonly string[];
  readonly approvalMode: string;
  readonly dryRun?: boolean;
}

/** System prompt baseline that primes the agent's behaviour. */
export function buildSystemPrompt(options: InitialPromptOptions): string {
  return [
    'You are a senior coding agent operating inside a sandboxed workspace.',
    `Workspace: ${options.workspace}`,
    `Approval mode: ${options.approvalMode}`,
    options.dryRun ? 'Dry-run mode: write tools will not mutate disk; report planned changes only.' : '',
    '',
    'Available tools:',
    ...options.toolNames.map((name) => `  - ${name}`),
    '',
    'Operating rules:',
    '  1. Read before you write. Use list_dir / read_file / grep to ground every change.',
    '  2. After substantive edits, run run_tests and react to failures.',
    '  3. Never call shell commands outside the allowlist; the host enforces it.',
    '  4. When the task is complete, output a final assistant message with',
    '     a short summary of changes plus a list of files touched.',
    '  5. If you cannot complete the task safely, say so explicitly and stop',
    '     calling tools — the host will record the abort and exit cleanly.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Build the initial conversation seeded by the user's task. */
export function buildInitialMessages(options: InitialPromptOptions): Message[] {
  return [
    { role: 'system', content: buildSystemPrompt(options) },
    { role: 'user', content: options.prompt },
  ];
}

/** Initial single-step plan; the AgentLoop expands it during execution. */
export function buildInitialPlan(prompt: string): TaskPlan {
  return {
    objective: prompt.split('\n')[0].slice(0, 200),
    steps: [
      { id: 'step-1', description: 'Decompose and execute the task.', toolHints: [] },
    ],
    status: 'draft',
  };
}
