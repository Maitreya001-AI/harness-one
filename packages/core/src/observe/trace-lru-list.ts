/**
 * Intrusive doubly-linked LRU list used by the trace-manager.
 *
 * The list keeps its prev/next pointers and membership flag in an internal
 * `WeakMap<T, LruNode>` keyed on the caller's object. Users never see the
 * pointers — the previous Wave-15 design exposed them on the value type and
 * relied on convention to prevent callers from mutating them. Moving the
 * pointers into a private WeakMap makes that a type error instead of a
 * style rule, while still giving the trace-manager O(1) link / unlink /
 * shift-oldest on every trace lifecycle event.
 *
 * ## When to use this vs. `infra/lru-cache`
 *
 * This list holds **no payload** — callers keep the actual objects in a
 * sibling `Map<string, T>` and use the list only to pick the next eviction
 * victim in O(1). Reach for this shape when:
 *
 *   - the same eviction must drive multiple side-tables (span counters,
 *     per-trace metadata, tag indexes, etc.),
 *   - `move-to-tail` is called on every read (hot-path access reordering).
 *
 * For every other "look up a value by key with LRU eviction" use case,
 * prefer the `LRUCache` in `core/infra/lru-cache.ts`. See that module's header for
 * the full decision table.
 *
 * @module
 * @internal
 */

/**
 * Internal node state. Declared private so callers can't mutate it from
 * outside the list.
 */
interface LruNode<T> {
  prev: T | null;
  next: T | null;
}

/**
 * Intrusive doubly-linked list ordered oldest → newest. `head` is the
 * oldest entry (the one evicted first); `tail` is the most recently
 * appended. Generic over the value type — the list tracks membership via
 * an internal `WeakMap<T, LruNode<T>>` so callers don't need to embed
 * anything on their value shape.
 */
export class TraceLruList<T extends object> {
  private _head: T | null = null;
  private _tail: T | null = null;
  private _size = 0;
  private readonly nodes = new WeakMap<T, LruNode<T>>();

  get size(): number {
    return this._size;
  }

  /** Append `node` at the tail (most recent). No-op if already linked. */
  append(node: T): void {
    if (this.nodes.has(node)) return;
    const entry: LruNode<T> = { prev: this._tail, next: null };
    this.nodes.set(node, entry);
    if (this._tail) {
      const tailEntry = this.nodes.get(this._tail);
      if (tailEntry) tailEntry.next = node;
    } else {
      this._head = node;
    }
    this._tail = node;
    this._size++;
  }

  /** Unlink `node` regardless of position. No-op if not linked. */
  remove(node: T): void {
    const entry = this.nodes.get(node);
    if (!entry) return;
    const prev = entry.prev;
    const next = entry.next;
    if (prev) {
      const prevEntry = this.nodes.get(prev);
      if (prevEntry) prevEntry.next = next;
    } else {
      this._head = next;
    }
    if (next) {
      const nextEntry = this.nodes.get(next);
      if (nextEntry) nextEntry.prev = prev;
    } else {
      this._tail = prev;
    }
    this.nodes.delete(node);
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
    // The WeakMap drops its references automatically once nodes become
    // unreachable; the owning trace-manager clears its trace map at the
    // same time, so walking the list to null prev/next is redundant.
    this._head = null;
    this._tail = null;
    this._size = 0;
  }
}
