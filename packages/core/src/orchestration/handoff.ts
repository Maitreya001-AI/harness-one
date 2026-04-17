/**
 * Structured handoff protocol layered on the agent orchestrator.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import {
  serializePayloadSafe,
  DEFAULT_PAYLOAD_MAX_BYTES,
  DEFAULT_PAYLOAD_MAX_DEPTH,
} from './safe-payload.js';
import type {
  HandoffManager,
  HandoffPayload,
  HandoffReceipt,
  HandoffVerificationResult,
  MessageTransport,
} from './types.js';

const HANDOFF_PREFIX = '__handoff__:';
const DEFAULT_MAX_RECEIPTS = 10_000;
const DEFAULT_MAX_INBOX_PER_AGENT = 1_000;

/** Fix 28: Configuration for handoff behavior. */
export interface HandoffConfig {
  /** Optional TTL for receipts in milliseconds. When set, receipts older than this are evicted. */
  readonly receiptTtlMs?: number;
  /** Maximum number of receipts to retain. Default: 10000. */
  readonly maxReceipts?: number;
  /** Maximum inbox size per agent. Default: 1000. */
  readonly maxInboxPerAgent?: number;
  /**
   * Wave-5E SEC-A11: maximum serialised payload size in bytes. Default
   * 64 KiB. Exceeding this throws `ORCH_HANDOFF_SERIALIZATION_ERROR`.
   */
  readonly maxPayloadBytes?: number;
  /**
   * Wave-5E SEC-A11: maximum nested depth of a handoff payload. Default
   * 16. Exceeding this throws `ORCH_HANDOFF_SERIALIZATION_ERROR` before
   * JSON.stringify runs, so pathological recursive objects cannot exhaust
   * the call stack.
   */
  readonly maxPayloadDepth?: number;
}

/**
 * Wave-5E SEC-A10: sealed handle binding a `from` agent identity. Created
 * via {@link HandoffManager.createSendHandle}; issuing code passes the
 * handle to the sender instead of letting the sender supply its own `from`
 * string. Prevents agents from forging turn-of-origin on outbound handoffs.
 */
export interface SendHandle {
  /** @internal — read-only identifier for debug/telemetry only. */
  readonly from: string;
  /** Send a payload to another agent. Returns the handoff receipt. */
  send(to: string, payload: HandoffPayload): HandoffReceipt;
}

/**
 * Create a HandoffManager that layers structured handoff semantics
 * on top of any {@link MessageTransport}.
 *
 * The transport only needs `send()` — the `AgentOrchestrator` returned by
 * {@link createOrchestrator} already satisfies this interface, but
 * lightweight custom transports work too.
 *
 * @example
 * ```ts
 * const orch = createOrchestrator();
 * const handoff = createHandoff(orch);
 * const receipt = handoff.send('agent-a', 'agent-b', { summary: 'Do X' });
 * const payload = handoff.receive('agent-b');
 * ```
 *
 * @example Custom transport
 * ```ts
 * const transport: MessageTransport = {
 *   send(msg) { channel.publish(msg); },
 * };
 * const handoff = createHandoff(transport);
 * ```
 */
export function createHandoff(transport: MessageTransport, handoffConfig?: HandoffConfig): HandoffManager {
  const receipts = new Map<string, HandoffReceipt>();
  const inbox = new Map<string, HandoffPayload[]>();
  // Note: nextId is a monotonically increasing counter. In practice, reaching
  // Number.MAX_SAFE_INTEGER (2^53) handoffs is unrealistic for any single session.
  let nextId = 0;

  const receiptTtlMs = handoffConfig?.receiptTtlMs;
  const maxReceipts = handoffConfig?.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
  const maxInboxPerAgent = handoffConfig?.maxInboxPerAgent ?? DEFAULT_MAX_INBOX_PER_AGENT;

  // Wave-5E SEC-A11 / Wave-15: depth + byte caps delegate to the shared
  // safe-payload helper so a single module owns the cross-agent
  // serialization contract.
  const MAX_HANDOFF_PAYLOAD_BYTES = handoffConfig?.maxPayloadBytes ?? DEFAULT_PAYLOAD_MAX_BYTES;
  const MAX_HANDOFF_PAYLOAD_DEPTH = handoffConfig?.maxPayloadDepth ?? DEFAULT_PAYLOAD_MAX_DEPTH;

  function serializePayload(payload: HandoffPayload): string {
    const body = serializePayloadSafe(payload, {
      maxBytes: MAX_HANDOFF_PAYLOAD_BYTES,
      maxDepth: MAX_HANDOFF_PAYLOAD_DEPTH,
      errorCode: HarnessErrorCode.ORCH_HANDOFF_SERIALIZATION_ERROR,
    });
    return HANDOFF_PREFIX + body;
  }

  // Fix 28: Evict receipts by TTL
  function evictExpiredReceipts(): void {
    if (!receiptTtlMs) return;
    const now = Date.now();
    for (const [key, receipt] of receipts) {
      if (now - receipt.timestamp > receiptTtlMs) {
        receipts.delete(key);
      }
    }
  }

  const manager: HandoffManager = {
    createSendHandle(from: string): SendHandle {
      if (!from || typeof from !== 'string') {
        throw new HarnessError(
          'createSendHandle: from agent ID must be a non-empty string',
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'Provide a valid agent ID',
        );
      }
      // Closure-captured `from` — the returned object exposes it only
      // read-only; `send(to, payload)` always routes through manager.send
      // with the bound identity.
      const boundFrom = from;
      const handle: SendHandle = Object.freeze({
        get from() { return boundFrom; },
        send(to: string, payload: HandoffPayload): HandoffReceipt {
          return manager.send(boundFrom, to, payload);
        },
      });
      return handle;
    },

    send(from: string, to: string, payload: HandoffPayload): HandoffReceipt {
      if (!from || typeof from !== 'string') {
        throw new HarnessError('from agent ID must be a non-empty string', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a valid agent ID for the sender');
      }
      if (!to || typeof to !== 'string') {
        throw new HarnessError('to agent ID must be a non-empty string', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a valid agent ID for the receiver');
      }
      const content = serializePayload(payload);

      transport.send({
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

      // Fix 28: Evict expired receipts by TTL
      evictExpiredReceipts();

      // Evict oldest receipts if over capacity
      if (receipts.size > maxReceipts) {
        const excess = receipts.size - maxReceipts;
        const iter = receipts.keys();
        for (let i = 0; i < excess; i++) {
          const key = iter.next().value;
          if (key !== undefined) receipts.delete(key);
        }
      }

      let queue = inbox.get(to);
      if (!queue) {
        queue = [];
        inbox.set(to, queue);
      }

      // A1-4 (Wave 4b): push + eviction must be one atomic critical section so
      // that concurrent `send()` invocations never leave the queue longer than
      // `maxInboxPerAgent`. `send()` is synchronous and this block contains no
      // `await`, so JS's single-threaded event-loop already guarantees
      // atomicity — two interleaving senders is not representable without an
      // explicit yield point. Kept compact and free of awaits on purpose; any
      // future refactor that introduces `await` between the push and the
      // eviction MUST wrap this block in a per-agent AsyncLock (see
      // `createAsyncLock` in core/infra). The test
      // "200 concurrent sends never exceed maxInboxPerAgent" enforces the
      // invariant.
      // Fix 29: Insert by priority
      const priorityPayload = Object.freeze(payload);
      insertByPriority(queue, priorityPayload);

      // Evict oldest inbox entries if over capacity
      while (queue.length > maxInboxPerAgent) {
        queue.pop(); // Remove lowest priority (at end)
      }

      return receipt;
    },

    receive(agentId: string): HandoffPayload | undefined {
      const queue = inbox.get(agentId);
      if (!queue || queue.length === 0) return undefined;
      return queue.shift();
    },

    history(agentId: string): readonly HandoffReceipt[] {
      // Fix 28: Evict expired before returning
      evictExpiredReceipts();

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

/**
 * Fix 29 + PERF-003: Insert a payload into a priority-sorted queue.
 *
 * The queue is ordered by rank descending (highest rank first). We binary-
 * search for the first index whose rank is strictly less than the new
 * payload's rank — that is the insertion boundary that preserves FIFO order
 * within the same priority tier (new item goes AFTER existing same-rank
 * items). Worst case: O(log n) comparisons + O(n) splice. Previous impl was
 * O(n) comparisons on every insert.
 */
function extractPriority(payload: HandoffPayload): string {
  return payload.priority ?? 'normal';
}

function insertByPriority(queue: HandoffPayload[], payload: HandoffPayload): void {
  const rank = priorityRank(extractPriority(payload));

  // Binary search for the first index `i` where rank(queue[i]) < rank.
  // Equal-rank items keep FIFO because we target the boundary AFTER them.
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (priorityRank(extractPriority(queue[mid])) >= rank) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  queue.splice(lo, 0, payload);
}

function priorityRank(priority: string): number {
  switch (priority) {
    case 'high': return 3;
    case 'normal': return 2;
    case 'low': return 1;
    default: return 2;
  }
}
