/**
 * Canonical fixtures exercised by the adapter contract suite.
 *
 * Every fixture carries:
 *   - a stable `name` used as the cassette filename (`<name>.jsonl`),
 *   - the `ChatParams` to issue, which is what `record` replays against
 *     the real adapter and what `replay` fingerprints,
 *   - a set of `expect.*` flags that drive per-scenario assertions (e.g.
 *     "this cassette should contain tool calls").
 *
 * Fixtures are defined in a single place so the same source of truth
 * powers both `createAdapterContractSuite` and the re-record script
 * used by the nightly workflow.
 *
 * @module
 */

import type { ChatParams } from '../../core/types.js';

/** Compile-time description of what a fixture is expected to contain. */
export interface ContractFixtureExpectations {
  /** The assistant message should include at least one tool call. */
  readonly toolCall?: boolean;
  /** The response should have non-empty textual content. */
  readonly text?: boolean;
  /** Streaming only — the cassette should contain a `done` chunk. */
  readonly doneChunk?: boolean;
}

/** A single scenario recorded as its own cassette file. */
export interface ContractFixture {
  readonly name: string;
  readonly kind: 'chat' | 'stream';
  readonly params: ChatParams;
  readonly expect: ContractFixtureExpectations;
}

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Return the current temperature for a city.',
  parameters: {
    type: 'object' as const,
    properties: {
      city: { type: 'string' as const, description: 'City name' },
    },
    required: ['city'],
  },
};

/**
 * Minimal fixtures covering the AgentAdapter contract surface. Kept small
 * on purpose — each real-API re-record costs money and time, and the
 * contract suite derives many assertions from the same cassette.
 */
export const CONTRACT_FIXTURES: readonly ContractFixture[] = [
  {
    name: 'chat-simple',
    kind: 'chat',
    params: {
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      config: { temperature: 0, maxTokens: 16 },
    },
    expect: { text: true },
  },
  {
    name: 'chat-with-system',
    kind: 'chat',
    params: {
      messages: [
        { role: 'system', content: 'Reply with exactly one word.' },
        { role: 'user', content: 'Greet me.' },
      ],
      config: { temperature: 0, maxTokens: 16 },
    },
    expect: { text: true },
  },
  {
    name: 'chat-tool-call',
    kind: 'chat',
    params: {
      messages: [{ role: 'user', content: 'What is the temperature in Paris right now?' }],
      tools: [WEATHER_TOOL],
      config: { temperature: 0, maxTokens: 128 },
    },
    expect: { toolCall: true },
  },
  {
    name: 'stream-simple',
    kind: 'stream',
    params: {
      messages: [{ role: 'user', content: 'Count to three.' }],
      config: { temperature: 0, maxTokens: 32 },
    },
    expect: { text: true, doneChunk: true },
  },
  {
    name: 'stream-tool-call',
    kind: 'stream',
    params: {
      messages: [{ role: 'user', content: 'Call get_weather for Berlin.' }],
      tools: [WEATHER_TOOL],
      config: { temperature: 0, maxTokens: 128 },
    },
    expect: { toolCall: true, doneChunk: true },
  },
] as const;

/** Returns the canonical cassette filename for a fixture. */
export function cassetteFileName(fixture: ContractFixture): string {
  return `${fixture.name}.jsonl`;
}
