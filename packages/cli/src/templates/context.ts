/**
 * Template for the 'context' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules context`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import { createBudget, packContext, analyzeCacheStability } from 'harness-one/context';
import type { Message } from 'harness-one/core';

// 1. Set up token budget with named segments
const budget = createBudget({
  totalTokens: 4096,
  responseReserve: 1000,
  segments: [
    { name: 'system', maxTokens: 500, reserved: true },
    { name: 'history', maxTokens: 2000, trimPriority: 1 },
    { name: 'recent', maxTokens: 596, trimPriority: 0 },
  ],
});

console.log('System remaining:', budget.remaining('system'));
console.log('Needs trimming:', budget.needsTrimming());

// 2. Pack context with HEAD/MID/TAIL layout
const systemMsg: Message = { role: 'system', content: 'You are helpful.' };
const history: Message[] = [
  { role: 'user', content: 'What is TypeScript?' },
  { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
];
const latest: Message = { role: 'user', content: 'Tell me more.' };

const packed = packContext({
  head: [systemMsg],
  mid: history,
  tail: [latest],
  budget,
});

console.log('Packed messages:', packed.messages.length);
console.log('Truncated:', packed.truncated);

// 3. Analyze cache stability between iterations
const v1: Message[] = [systemMsg, ...history];
const v2: Message[] = [systemMsg, { role: 'user', content: 'Different question' }];
const report = analyzeCacheStability(v1, v2);
console.log('Cache prefix match:', report.prefixMatchRatio);
console.log('Recommendations:', report.recommendations);
`;
