/**
 * Intrusive doubly-linked LRU list used by the trace-manager.
 *
 * Nodes embed the prev/next pointers + a membership flag so every link /
 * unlink / shift-oldest operation is O(1). Extracted from `trace-manager.ts`
 * as a small standalone data structure so the factory body stays focused on
 * trace lifecycle rather than pointer bookkeeping.
 *
 * @module
 * @internal
 */

/**
 * Shape every LRU node must satisfy. The three fields are mutated in place
 * by {@link TraceLruList} — consumers MUST NOT touch them directly.
 */
export interface LruNode<T> {
  lruPrev: T | null;
  lruNext: T | null;
  inLru: boolean;
}

/**
 * Intrusive doubly-linked list ordered oldest → newest. `head` is the
 * oldest entry (the one evicted first); `tail` is the most recently
 * appended.
 */
export class TraceLruList<T extends LruNode<T>> {
  private _head: T | null = null;
  private _tail: T | null = null;
  private _size = 0;

  get size(): number {
    return this._size;
  }

  /** Append `node` at the tail (most recent). No-op if already linked. */
  append(node: T): void {
    if (node.inLru) return;
    node.lruPrev = this._tail;
    node.lruNext = null;
    if (this._tail) {
      this._tail.lruNext = node;
    } else {
      this._head = node;
    }
    this._tail = node;
    node.inLru = true;
    this._size++;
  }

  /** Unlink `node` regardless of position. No-op if not linked. */
  remove(node: T): void {
    if (!node.inLru) return;
    const prev = node.lruPrev;
    const next = node.lruNext;
    if (prev) prev.lruNext = next;
    else this._head = next;
    if (next) next.lruPrev = prev;
    else this._tail = prev;
    node.lruPrev = null;
    node.lruNext = null;
    node.inLru = false;
    this._size--;
  }

  /** Unlink and return the oldest entry, or `undefined` if empty. */
  shiftOldest(): T | undefined {
    const head = this._head;
    if (!head) return undefined;
    this.remove(head);
    return head;
  }

  /** Detach every node and reset size to zero. */
  clear(): void {
    // We deliberately don't walk the list to reset `inLru` on every node —
    // the owning trace-manager clears its trace map at the same time, so
    // the nodes become unreachable either way. Holding live references to
    // zombie nodes is never useful.
    this._head = null;
    this._tail = null;
    this._size = 0;
  }
}
