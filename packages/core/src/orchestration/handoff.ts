/**
 * Structured handoff protocol layered on the agent orchestrator.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type {
  HandoffManager,
  HandoffPayload,
  HandoffReceipt,
  HandoffVerificationResult,
} from './types.js';
import type { AgentOrchestrator } from './orchestrator.js';

const HANDOFF_PREFIX = '__handoff__:';

/**
 * Create a HandoffManager that layers structured handoff semantics
 * on top of an existing AgentOrchestrator.
 *
 * @example
 * ```ts
 * const orch = createOrchestrator();
 * const handoff = createHandoff(orch);
 * const receipt = handoff.send('agent-a', 'agent-b', { summary: 'Do X' });
 * const payload = handoff.receive('agent-b');
 * ```
 */
export function createHandoff(orchestrator: AgentOrchestrator): HandoffManager {
  const receipts = new Map<string, HandoffReceipt>();
  const inbox = new Map<string, HandoffPayload[]>();
  let nextId = 0;

  function serializePayload(payload: HandoffPayload): string {
    try {
      return HANDOFF_PREFIX + JSON.stringify(payload);
    } catch (err) {
      throw new HarnessError(
        `Failed to serialize handoff payload: ${err instanceof Error ? err.message : String(err)}`,
        'HANDOFF_SERIALIZATION_ERROR',
        'Ensure all values in the handoff payload are JSON-serializable',
      );
    }
  }

  const manager: HandoffManager = {
    send(from: string, to: string, payload: HandoffPayload): HandoffReceipt {
      const content = serializePayload(payload);

      orchestrator.send({
        from,
        to,
        type: 'request',
        content,
      });

      const id = `handoff-${nextId++}`;
      const receipt: HandoffReceipt = Object.freeze({
        id,
        from,
        to,
        timestamp: Date.now(),
        payload: Object.freeze(payload),
      });

      receipts.set(id, receipt);

      let queue = inbox.get(to);
      if (!queue) {
        queue = [];
        inbox.set(to, queue);
      }
      queue.push(Object.freeze(payload));

      return receipt;
    },

    receive(agentId: string): HandoffPayload | undefined {
      const queue = inbox.get(agentId);
      if (!queue || queue.length === 0) return undefined;
      return queue.shift();
    },

    history(agentId: string): readonly HandoffReceipt[] {
      const result: HandoffReceipt[] = [];
      for (const receipt of receipts.values()) {
        if (receipt.from === agentId || receipt.to === agentId) {
          result.push(receipt);
        }
      }
      return result;
    },

    verify(
      receiptId: string,
      output: unknown,
      verifier: (criterion: string, output: unknown) => boolean,
    ): HandoffVerificationResult {
      const receipt = receipts.get(receiptId);
      if (!receipt) {
        return Object.freeze({ passed: false, violations: Object.freeze(['Unknown receipt ID']) });
      }

      const criteria = receipt.payload.acceptanceCriteria;
      if (!criteria || criteria.length === 0) {
        return Object.freeze({ passed: true, violations: Object.freeze([]) });
      }

      const violations: string[] = [];
      for (const criterion of criteria) {
        if (!verifier(criterion, output)) {
          violations.push(criterion);
        }
      }

      return Object.freeze({
        passed: violations.length === 0,
        violations: Object.freeze(violations),
      });
    },

    dispose(): void {
      receipts.clear();
      inbox.clear();
      nextId = 0;
    },
  };

  return manager;
}
