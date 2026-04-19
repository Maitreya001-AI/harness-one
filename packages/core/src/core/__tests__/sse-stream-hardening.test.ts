/**
 * SSE stream fallback hardening:
 *
 *   - fallback path defensively clamps `String(err).slice(0, 200)`
 *     so a maliciously large / exotic error reason cannot blow up
 *     the SSE envelope.
 */

import { describe, it, expect } from 'vitest';
import { toSSEStream } from '../sse-stream.js';
import type { AgentEvent } from '../events.js';

async function* fromArray(events: unknown[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e as AgentEvent;
}

describe('toSSEStream — fallback reason clamped to 200 chars', () => {
  it('clamps a giant throwing-getter error reason to ≤200 chars inside the fallback envelope', async () => {
    // Craft an event whose primary JSON.stringify throws — a throwing
    // getter on a property reached by the stringifier. The fallback then
    // tries to stringify an `{ error, reason: String(err).slice(0,200) }`
    // envelope; we want to verify the reason respects the 200-char cap.
    const hugeReason = 'X'.repeat(5000);
    const poisoned = {
      type: 'message',
      get message(): unknown {
        throw new Error(hugeReason);
      },
    };

    const chunks: { event: string; data: string }[] = [];
    for await (const chunk of toSSEStream(fromArray([poisoned]))) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].event).toBe('error');
    const parsed = JSON.parse(chunks[0].data) as { error: string; reason: string };
    expect(parsed.error).toBe('Event serialization failed');
    // Reason string is a substring of the original — must not exceed 200.
    expect(parsed.reason.length).toBeLessThanOrEqual(200);
    expect(parsed.reason).toContain('X');
  });

  it('falls through to the pre-frozen byte constant when String(err) itself throws', async () => {
    // Error whose .toString() throws — forces `String(err)` to throw and
    // thus exercise the inner catch that replaces the reason with
    // "unserializable error"; the outer stringify still succeeds, so we
    // should see an `error` envelope (not the pre-frozen fallback).
    const exoticErr = {
      toString(): string {
        throw new Error('toString exploded');
      },
    };
    const poisoned = {
      type: 'message',
      get message(): unknown {
        throw exoticErr;
      },
    };

    const chunks: { event: string; data: string }[] = [];
    for await (const chunk of toSSEStream(fromArray([poisoned]))) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].event).toBe('error');
    const parsed = JSON.parse(chunks[0].data) as { error: string; reason: string };
    expect(parsed.reason).toBe('unserializable error');
  });
});
